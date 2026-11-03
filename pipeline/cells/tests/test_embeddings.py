from pipeline.cells.embeddings import cosine, pca


def test_cosine():
    assert abs(cosine([1, 0], [1, 0]) - 1) < 1e-12
    assert abs(cosine([1, 0], [0, 2])) < 1e-12
    assert cosine([0, 0], [1, 1]) is None


def test_pca_finds_the_main_axis():
    rows = [[t, 2 * t, 0.01 * (-1) ** i] for i, t in enumerate(range(-10, 11))]
    mu, comp, var = pca(rows, 1)
    assert abs(abs(comp[0][1] / comp[0][0]) - 2) < 1e-6
    assert var[0] > 0.99
    assert abs(mu[0]) < 1e-12
