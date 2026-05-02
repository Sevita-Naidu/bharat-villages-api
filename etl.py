"""
ETL Script — All India Villages Master List
============================================
Reads 30 state XLS/ODS files from a ZIP, cleans the data,
and loads it into a normalized PostgreSQL database.

Run:
    pip install pandas xlrd odfpy psycopg2-binary openpyxl
    python etl.py
"""

import os
import subprocess
import zipfile
import pandas as pd
import psycopg2
from psycopg2.extras import execute_batch
import tempfile  # faster than inserting row by row

# ─────────────────────────────────────────────
# CONFIGURATION — change these to your values
# ─────────────────────────────────────────────

ZIP_PATH = ZIP_PATH = r"C:\Users\vsevi\Downloads\all-india-villages-master-list-excel.zip"

# NeonDB connection string — you'll get this from neon.tech after creating a DB
# Format: postgresql://user:password@host/dbname?sslmode=require
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://neondb_owner:npg_mXGBhN7zeY0U@ep-summer-wave-an85tk43-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require")

BATCH_SIZE = 5000  # how many rows to insert at once — keeps memory usage low


# ─────────────────────────────────────────────
# HELPER: SMART FILE READER
# ─────────────────────────────────────────────

def read_state_file(file_bytes, filename):
    """
    Reads a state file (XLS or ODS) and returns a DataFrame.

    Why two paths?
    - .xls  → pandas xlrd engine reads directly and quickly
    - .ods  → pandas odf engine HANGS on large files (UP has 107k rows)
              Fix: convert ODS to CSV via LibreOffice headless first,
              then read the CSV. LibreOffice handles ODS natively in seconds.

    LibreOffice must be installed:
        Ubuntu/Debian: sudo apt install libreoffice
        Mac: brew install --cask libreoffice
    """
    extension = filename.split('.')[-1].lower()
    import tempfile
    temp_input = os.path.join(tempfile.gettempdir(), f'temp_state.{extension}')

    with open(temp_input, 'wb') as f:
        f.write(file_bytes)

    if extension == 'xls':
        df = pd.read_excel(temp_input, engine='xlrd')

    elif extension == 'ods':
        # Convert ODS → CSV using LibreOffice headless (no UI)
        result = subprocess.run(
            ['libreoffice', '--headless', '--convert-to', 'csv',
             temp_input, '--outdir', '/tmp/'],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            raise RuntimeError(f"LibreOffice conversion failed: {result.stderr}")

        # LibreOffice names output based on input filename
        converted_csv = os.path.join(tempfile.gettempdir(), filename.replace('.ods', '.csv'))
        df = pd.read_csv(converted_csv, encoding='utf-8', on_bad_lines='skip')
        os.remove(converted_csv)

    else:
        raise ValueError(f"Unsupported file type: {extension}")

    os.remove(temp_input)
    return df


# ─────────────────────────────────────────────
# STAGE 1: READ ALL FILES FROM ZIP
# ─────────────────────────────────────────────

def read_all_files(zip_path):
    """
    Opens the ZIP and reads every .xls / .ods file inside it.
    Returns a single combined DataFrame with all rows from all states.
    """
    all_dataframes = []

    with zipfile.ZipFile(zip_path, 'r') as z:
        state_files = [
            f for f in z.namelist()
            if 'dataset/' in f
            and '__MACOSX' not in f
            and (f.endswith('.xls') or f.endswith('.ods'))
        ]

        print(f"Found {len(state_files)} state files\n")

        for file_path in sorted(state_files):
            filename = file_path.split('/')[-1]
            print(f"  Reading: {filename}")

            try:
                file_bytes = z.read(file_path)
                df = read_state_file(file_bytes, filename)
                all_dataframes.append(df)
                print(f"    → {len(df)} rows loaded")
            except Exception as e:
                print(f"    ✗ ERROR reading {filename}: {e}")

    combined = pd.concat(all_dataframes, ignore_index=True)
    print(f"\nTotal raw rows across all states: {len(combined)}")
    return combined


# ─────────────────────────────────────────────
# STAGE 2: CLEAN THE DATA
# ─────────────────────────────────────────────

def clean_data(df):
    """
    Cleans the raw DataFrame:
    1. Removes header/summary rows (where MDDS PLCN == 0)
    2. Strips whitespace from all text columns
    3. Converts code columns to integers
    4. Removes any fully duplicate rows
    """

    print("\nCleaning data...")
    print(f"  Before cleaning: {len(df)} rows")

    # Step 1: Remove non-village rows
    # Rows where MDDS PLCN (village code) is 0 are state/district/subdistrict
    # summary rows — NOT actual villages. We don't need them.
    df = df[df['MDDS PLCN'] != 0].copy()
    print(f"  After removing header rows: {len(df)} rows")

    # Step 2: Strip leading/trailing whitespace from text columns
    # 'Arambakkam ' becomes 'Arambakkam'
    text_columns = ['STATE NAME', 'DISTRICT NAME', 'SUB-DISTRICT NAME', 'Area Name']
    for col in text_columns:
        df[col] = df[col].astype(str).str.strip()

    # Step 3: Ensure code columns are integers (sometimes read as floats)
    # Step 3: Drop rows where any code column is NaN (empty cells in source files)
    code_columns = ['MDDS STC', 'MDDS DTC', 'MDDS Sub_DT', 'MDDS PLCN']
    before = len(df)
    df = df.dropna(subset=code_columns)
    dropped = before - len(df)
    if dropped:
        print(f"  Dropped {dropped} rows with empty code columns")

    # Now safe to convert to int
    for col in code_columns:
        df[col] = df[col].astype(int)

    # Step 4: Drop exact duplicate rows (same village code appearing twice)
    before = len(df)
    df = df.drop_duplicates(subset=['MDDS PLCN'])
    after = len(df)
    if before != after:
        print(f"  Removed {before - after} duplicate village codes")

    print(f"  After cleaning: {len(df)} rows (actual villages)")
    return df


# ─────────────────────────────────────────────
# STAGE 3: BUILD HIERARCHY TABLES
# ─────────────────────────────────────────────

def extract_hierarchy(df):
    """
    From the flat village rows, extract 4 separate clean tables:
    - states:        unique states with their codes
    - districts:     unique districts with state reference
    - subdistricts:  unique sub-districts with district reference
    - villages:      all villages with sub-district reference

    This is called 'normalization' — instead of repeating
    'TAMIL NADU' 16,000 times, we store it once and reference it by ID.
    """

    print("\nExtracting hierarchy tables...")

    # STATES — unique state code + state name combinations
    states = df[['MDDS STC', 'STATE NAME']].drop_duplicates()
    states = states.rename(columns={'MDDS STC': 'state_code', 'STATE NAME': 'state_name'})
    states = states.sort_values('state_code').reset_index(drop=True)
    print(f"  States found: {len(states)}")

    # DISTRICTS — unique district code + name + which state they belong to
    districts = df[['MDDS DTC', 'DISTRICT NAME', 'MDDS STC']].drop_duplicates()
    districts = districts.rename(columns={
        'MDDS DTC': 'district_code',
        'DISTRICT NAME': 'district_name',
        'MDDS STC': 'state_code'
    })
    districts = districts.sort_values('district_code').reset_index(drop=True)
    print(f"  Districts found: {len(districts)}")

    # SUB-DISTRICTS — unique sub-district code + name + which district
    subdistricts = df[['MDDS Sub_DT', 'SUB-DISTRICT NAME', 'MDDS DTC']].drop_duplicates()
    subdistricts = subdistricts.rename(columns={
        'MDDS Sub_DT': 'subdistrict_code',
        'SUB-DISTRICT NAME': 'subdistrict_name',
        'MDDS DTC': 'district_code'
    })
    subdistricts = subdistricts.sort_values('subdistrict_code').reset_index(drop=True)
    print(f"  Sub-districts found: {len(subdistricts)}")

    # VILLAGES — all villages with their sub-district reference
    villages = df[['MDDS PLCN', 'Area Name', 'MDDS Sub_DT']].copy()
    villages = villages.rename(columns={
        'MDDS PLCN': 'village_code',
        'Area Name': 'village_name',
        'MDDS Sub_DT': 'subdistrict_code'
    })
    print(f"  Villages found: {len(villages)}")

    return states, districts, subdistricts, villages


# ─────────────────────────────────────────────
# STAGE 4: DATABASE SETUP & INSERT
# ─────────────────────────────────────────────

def create_tables(conn):
    """
    Creates the 4 normalized tables in PostgreSQL.
    Uses CREATE TABLE IF NOT EXISTS so it's safe to run multiple times.
    """
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS states (
                id          SERIAL PRIMARY KEY,
                state_code  INTEGER UNIQUE NOT NULL,
                state_name  VARCHAR(100) NOT NULL
            );

            CREATE TABLE IF NOT EXISTS districts (
                id            SERIAL PRIMARY KEY,
                district_code INTEGER UNIQUE NOT NULL,
                district_name VARCHAR(150) NOT NULL,
                state_id      INTEGER REFERENCES states(id)
            );

            CREATE TABLE IF NOT EXISTS subdistricts (
                id                SERIAL PRIMARY KEY,
                subdistrict_code  INTEGER UNIQUE NOT NULL,
                subdistrict_name  VARCHAR(150) NOT NULL,
                district_id       INTEGER REFERENCES districts(id)
            );

            CREATE TABLE IF NOT EXISTS villages (
                id               SERIAL PRIMARY KEY,
                village_code     INTEGER UNIQUE NOT NULL,
                village_name     VARCHAR(200) NOT NULL,
                subdistrict_id   INTEGER REFERENCES subdistricts(id)
            );

            -- Index on village name for fast text search
            CREATE INDEX IF NOT EXISTS idx_village_name
                ON villages (LOWER(village_name));

            -- Index for hierarchy joins
            CREATE INDEX IF NOT EXISTS idx_village_subdistrict
                ON villages (subdistrict_id);
        """)
        conn.commit()
        print("\nDatabase tables created successfully")


def insert_states(conn, states_df):
    """Insert all states into the states table."""
    with conn.cursor() as cur:
        data = [
            (row['state_code'], row['state_name'])
            for _, row in states_df.iterrows()
        ]
        execute_batch(cur, """
            INSERT INTO states (state_code, state_name)
            VALUES (%s, %s)
            ON CONFLICT (state_code) DO UPDATE
                SET state_name = EXCLUDED.state_name
        """, data)
        conn.commit()
    print(f"  Inserted {len(data)} states")


def insert_districts(conn, districts_df):
    """Insert all districts, linking each to its state via foreign key."""
    with conn.cursor() as cur:
        data = []
        for _, row in districts_df.iterrows():
            # Look up the state's database ID using state_code
            cur.execute("SELECT id FROM states WHERE state_code = %s", (row['state_code'],))
            result = cur.fetchone()
            if result:
                state_id = result[0]
                data.append((row['district_code'], row['district_name'], state_id))

        execute_batch(cur, """
            INSERT INTO districts (district_code, district_name, state_id)
            VALUES (%s, %s, %s)
            ON CONFLICT (district_code) DO UPDATE
                SET district_name = EXCLUDED.district_name
        """, data)
        conn.commit()
    print(f"  Inserted {len(data)} districts")


def insert_subdistricts(conn, subdistricts_df):
    """Insert all sub-districts, linking each to its district."""
    with conn.cursor() as cur:
        data = []
        for _, row in subdistricts_df.iterrows():
            cur.execute("SELECT id FROM districts WHERE district_code = %s", (row['district_code'],))
            result = cur.fetchone()
            if result:
                district_id = result[0]
                data.append((row['subdistrict_code'], row['subdistrict_name'], district_id))

        execute_batch(cur, """
            INSERT INTO subdistricts (subdistrict_code, subdistrict_name, district_id)
            VALUES (%s, %s, %s)
            ON CONFLICT (subdistrict_code) DO UPDATE
                SET subdistrict_name = EXCLUDED.subdistrict_name
        """, data)
        conn.commit()
    print(f"  Inserted {len(data)} sub-districts")


def insert_villages(conn, villages_df):
    """
    Insert all villages in batches of BATCH_SIZE.
    Batching is important here — 6 lakh rows inserted one by one
    would take forever. Batches of 5000 are much faster.
    """
    with conn.cursor() as cur:
        # First build a lookup dict: subdistrict_code → database id
        # This avoids a SELECT query for every single village
        cur.execute("SELECT subdistrict_code, id FROM subdistricts")
        subdistrict_map = {row[0]: row[1] for row in cur.fetchall()}

        data = []
        skipped = 0
        for _, row in villages_df.iterrows():
            sd_id = subdistrict_map.get(row['subdistrict_code'])
            if sd_id:
                data.append((row['village_code'], row['village_name'], sd_id))
            else:
                skipped += 1

        if skipped:
            print(f"  Warning: {skipped} villages skipped (sub-district not found)")

        # Insert in batches
        for i in range(0, len(data), BATCH_SIZE):
            batch = data[i:i + BATCH_SIZE]
            execute_batch(cur, """
                INSERT INTO villages (village_code, village_name, subdistrict_id)
                VALUES (%s, %s, %s)
                ON CONFLICT (village_code) DO UPDATE
                    SET village_name = EXCLUDED.village_name
            """, batch)
            conn.commit()
            print(f"  Villages inserted: {min(i + BATCH_SIZE, len(data))}/{len(data)}")

    print(f"  Done! Total villages inserted: {len(data)}")


def verify(conn):
    """Quick sanity check — print counts from each table."""
    with conn.cursor() as cur:
        print("\n=== VERIFICATION ===")
        for table in ['states', 'districts', 'subdistricts', 'villages']:
            cur.execute(f"SELECT COUNT(*) FROM {table}")
            count = cur.fetchone()[0]
            print(f"  {table}: {count:,} rows")

        # Test a real query — find Egumadurai village in Tamil Nadu
        cur.execute("""
            SELECT
                v.village_name,
                sd.subdistrict_name,
                d.district_name,
                s.state_name,
                v.village_code
            FROM villages v
            JOIN subdistricts sd ON v.subdistrict_id = sd.id
            JOIN districts d    ON sd.district_id = d.id
            JOIN states s       ON d.state_id = s.id
            WHERE LOWER(v.village_name) = 'egumadurai'
        """)
        row = cur.fetchone()
        if row:
            print(f"\n  Test query — 'Egumadurai':")
            print(f"  Village: {row[0]}, Sub-district: {row[1]}, District: {row[2]}, State: {row[3]}, Code: {row[4]}")


# ─────────────────────────────────────────────
# MAIN — runs everything in order
# ─────────────────────────────────────────────

def main():
    print("=" * 50)
    print("All India Villages ETL Pipeline")
    print("=" * 50)

    # Stage 1: Read
    raw_df = read_all_files(ZIP_PATH)

    # Stage 2: Clean
    clean_df = clean_data(raw_df)

    # Stage 3: Extract hierarchy
    states, districts, subdistricts, villages = extract_hierarchy(clean_df)

    # Stage 4: Insert into database
    print("\nConnecting to database...")
    conn = psycopg2.connect(DATABASE_URL)

    print("Creating tables...")
    create_tables(conn)

    print("\nInserting data...")
    insert_states(conn, states)
    insert_districts(conn, districts)
    insert_subdistricts(conn, subdistricts)
    insert_villages(conn, villages)

    # Verify everything loaded correctly
    verify(conn)

    conn.close()
    print("\nETL complete!")


if __name__ == "__main__":
    main()