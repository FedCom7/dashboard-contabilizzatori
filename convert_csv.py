#!/usr/bin/env python3
"""
Script per convertire il CSV delle letture dei contabilizzatori
in un formato JSON utilizzabile dall'app Dashboard.

Uso: python convert_csv.py [input.csv] [output.json]
"""

import csv
import json
import sys
from datetime import datetime

# Mapping stagione numerica -> formato testuale
# 1 = 18/19, 2 = 19/20, ecc.
STAGIONI_MAP = {
    1: "18/19",
    2: "19/20",
    3: "20/21",
    4: "21/22",
    5: "22/23",
    6: "23/24",
    7: "24/25",
    8: "25/26",
    9: "26/27",
    10: "27/28"
}

def parse_date(date_str):
    """Converte una data da MM/DD/YYYY a YYYY-MM-DD"""
    try:
        # Prova formato MM/DD/YYYY
        dt = datetime.strptime(date_str.strip(), "%m/%d/%Y")
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        try:
            # Prova formato DD/MM/YYYY
            dt = datetime.strptime(date_str.strip(), "%d/%m/%Y")
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            # Già in formato ISO
            return date_str.strip()

def convert_stagione(num):
    """Converte il numero stagione nel formato testuale"""
    try:
        n = int(num)
        return STAGIONI_MAP.get(n, f"{17+n}/{18+n}")
    except (ValueError, TypeError):
        return "24/25"  # Default

def convert_csv_to_json(input_file, output_file):
    """Legge il CSV e produce un JSON per l'app"""
    letture = []
    
    with open(input_file, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        
        for row in reader:
            # Normalizza i nomi delle colonne (lowercase)
            row = {k.lower().strip(): v.strip() if v else '0' for k, v in row.items()}
            
            lettura = {
                "data": parse_date(row.get("data", "")),
                "stagione": convert_stagione(row.get("stagione", "7")),
                "cucina": float(row.get("cucina", 0) or 0),
                "soggiorno": float(row.get("soggiorno", 0) or 0),
                "camera": float(row.get("camera", 0) or 0),
                "cameretta": float(row.get("cameretta", 0) or 0),
                "bagno": float(row.get("bagno", 0) or 0)
            }
            
            letture.append(lettura)
    
    # Ordina per data
    letture.sort(key=lambda x: x["data"])
    
    # Salva JSON
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(letture, f, indent=2, ensure_ascii=False)
    
    print(f"✅ Convertite {len(letture)} letture")
    print(f"📄 Output salvato in: {output_file}")
    
    # Mostra statistiche
    stagioni = set(l["stagione"] for l in letture)
    print(f"📊 Stagioni trovate: {', '.join(sorted(stagioni))}")
    
    return letture

if __name__ == "__main__":
    # File di default
    input_csv = sys.argv[1] if len(sys.argv) > 1 else "ImportCSV.csv"
    output_json = sys.argv[2] if len(sys.argv) > 2 else "letture.json"
    
    print(f"🔄 Conversione {input_csv} -> {output_json}")
    convert_csv_to_json(input_csv, output_json)
