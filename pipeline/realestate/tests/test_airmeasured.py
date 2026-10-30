from pipeline.realestate import airmeasured as a

TEXT = """
      City Railway Station, Majestic – May 2026
  Date       PM10      SO2      NO2      CO       AQI
 Average     110.6     9.7      52.1     1.27      *
                               R.V.College of Engineering, Kengeri - January 2026
             PM10    PM2.5    SO2     NO2     CO
  Date                                                AQI
 Average     110.0   46.8     4.5    16.8    0.55    *
"""


def test_month_averages_reads_both_header_layouts():
    m = a.month_averages(TEXT)
    assert m[0] == {"pm10": 110.6, "no2": 52.1} and m[7] == {"pm10": 110.0, "pm25": 46.8, "no2": 16.8}


def test_station_means_and_nearest_pm25_station():
    means = a.station_means([a.month_averages(TEXT), a.month_averages(TEXT.replace("110.0", "50.0"))])
    assert means[7]["pm10"] == 80.0 and means[7]["over"] == 1 and means[0]["over"] == 2
    r = a.block_rows([("x", 12.978, 77.57)], means)["x"]
    assert r["am_station"] == 1 and r["am_pm25"] == 46.8 and r["am_pm25_km"] > 5


def test_daily_months_groups_by_month_and_station():
    rows = [{"Date": "01 JANUARY", "Station": "Manali", "PM2.5": "40", "PM10": "70", "NO2": "-"},
            {"Date": "02 January", "Station": "Manali", "PM2.5": "20", "PM10": "50", "NO2": "10"},
            {"Date": "01 FEBRUARY", "Station": "Royapuram", "PM2.5": "22", "PM10": "52", "NO2": "17"}]
    m = a.daily_months(rows)
    assert len(m) == 2 and m[1][2] == {"pm10": 60.0, "pm25": 30.0, "no2": 10.0} and m[0][4]["pm25"] == 22.0


def test_quarter_hour_months_needs_enough_readings_and_the_year():
    head = "Station ID,State,City,Station Name,Timestamp,PM2.5 (µg/m³),PM10 (µg/m³),NO (µg/m³),NO2 (µg/m³)"
    rows = [f'x,MH,Pune,"A, Pune",2024-01-0{1 + i % 9}T00:00:00,{40 + i % 2},100,5,' + ("20" if i < 1000 else "") for i in range(1200)]
    rows += ['x,MH,Pune,"A, Pune",2024-02-01T00:00:00,50,90,5,20', 'x,MH,Pune,"A, Pune",2025-01-01T00:00:00,500,900,5,20']
    got = a.quarter_hour_months([head] + rows)
    assert set(got) == {"01"}
    assert round(got["01"]["pm25"], 1) == 40.5 and got["01"]["pm10"] == 100 and got["01"]["no2"] == 20
    assert a.by_month({0: got, 1: {"01": {"pm10": 60}}}) == [{0: got["01"], 1: {"pm10": 60}}]
