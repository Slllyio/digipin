/**
 * MobilityScore — pure helpers for the Law & Order Mobility (access-resilience)
 * layer. Mirrors pipeline/safety/mobility.py so browser and pipeline agree on
 * the access-class bands and colours. No DOM, no fetch — unit-tested.
 *
 * Defensive framing: this surfaces where authorities'/emergency movement can be
 * choked or sealed, so access can be PROTECTED. See docs/MOBILITY_MODEL.md.
 */
const MobilityScore = (() => {
    // Access classes (worst → best) with map/legend colours.
    const CLASSES = [
        { key: 'Restricted',  color: '#b30000', label: 'Restricted — hard to move/reach' },
        { key: 'Constrained', color: '#fc8d59', label: 'Constrained — limited access' },
        { key: 'Smooth',      color: '#31a354', label: 'Smooth — good access' },
    ];
    const _COLOR = CLASSES.reduce((m, c) => (m[c.key] = c.color, m), {});

    /** Qualitative band from a 0..100 risk; a sealable pocket is never 'Smooth'.
     *  Keep in sync with mobility.py access_class(). */
    function accessClass(risk, sealable = false) {
        if (sealable && (risk == null || risk < 66)) return 'Restricted';
        if (risk == null || !Number.isFinite(risk)) return null;
        if (risk >= 66) return 'Restricted';
        if (risk >= 40) return 'Constrained';
        return 'Smooth';
    }

    /** Colour for an access class (transparent when unknown). */
    function classColor(cls) {
        return _COLOR[cls] || 'rgba(0,0,0,0)';
    }

    return { CLASSES, accessClass, classColor };
})();

if (typeof window !== 'undefined') window.MobilityScore = MobilityScore;
