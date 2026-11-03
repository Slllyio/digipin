from pipeline.realestate.greenrank import city_rows


def _c(name, ndvi, country="India", pop=2_000_000, then=0.2, canopy=5.0):
    return {"name": name, "country": country, "pop": pop, "ndvi_2000": then, "ndvi_2025": ndvi, "canopy": canopy}


def test_city_rows_ranks_and_change():
    centres = [_c("Kolkata", 0.46, then=0.376, canopy=11.0), _c("New Delhi", 0.27, then=0.214, canopy=4.0),
               _c("Paris", 0.35, country="France", canopy=8.0), _c("Tiny", 0.9, pop=1000)]
    rows = city_rows(centres)
    k, d = rows["kolkata"], rows["delhi"]
    assert k["gr_ndvi_2025"] == 0.46 and k["gr_ndvi_change_pct"] == 22
    assert k["gr_world_pctile"] == 83 and k["gr_india_pctile"] == 75
    assert d["gr_world_pctile"] == 17 and d["gr_canopy_m"] == 4.0
    assert "mumbai" not in rows


def test_city_rows_skips_missing_ndvi():
    assert city_rows([_c("Pune", None)]) == {}
