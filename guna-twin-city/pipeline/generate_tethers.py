import json
import sys

def create_tethers(input_geojson, output_geojson, offset_height=100):
    print(f"Reading {input_geojson}...")
    with open(input_geojson, 'r', encoding='utf-8') as f:
        data = json.load(f)

    tether_features = []

    for feature in data.get('features', []):
        geom = feature.get('geometry')
        if not geom: continue

        tether_feature = {
            "type": "Feature",
            "geometry": geom,
            "properties": {
                **(feature.get('properties', {})),
                "tether_height": offset_height,
                "tether_base": 0
            }
        }
        tether_features.append(tether_feature)

    output = {
        "type": "FeatureCollection",
        "features": tether_features
    }

    print(f"Generated {len(tether_features)} footprint tethers. Saving to {output_geojson}...")
    with open(output_geojson, 'w', encoding='utf-8') as f:
        json.dump(output, f)
    print("Done!")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python generate_tethers.py <input.geojson> <output.geojson>")
        sys.exit(1)

    input_f = sys.argv[1]
    output_f = sys.argv[2]
    create_tethers(input_f, output_f)
