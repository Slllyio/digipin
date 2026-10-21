/**
 * Setup file for Vitest with jsdom.
 *
 * DigiPin and DataFetcher are IIFE modules that rely on browser script-tag
 * global hoisting:  `const DigiPin = (() => {...})();` becomes globally
 * accessible inside a <script> tag, but **not** when evaluated via
 * `vm.runInNewContext` — `const` declarations are lexically scoped to the
 * script and don't attach to the context object.
 *
 * Fix: read the source, **append** `globalThis.<Name> = <Name>` lines so
 * the IIFE's const becomes reachable, then evaluate via
 * `vm.runInThisContext` so the assignments hit the Vitest worker's
 * globalThis (not a fresh sandbox).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(__dirname);

function loadGlobalScript(relPath, exposeNames) {
    const filePath = path.join(rootDir, relPath);
    let code = readFileSync(filePath, 'utf-8');
    for (const name of exposeNames) {
        code += `\nif (typeof ${name} !== 'undefined') globalThis.${name} = ${name};`;
    }
    vm.runInThisContext(code, { filename: relPath });
}

loadGlobalScript('js/digipin.js', ['DigiPin']);
loadGlobalScript('js/overture-release.js', ['OvertureRelease']);
loadGlobalScript('js/terrain.js', ['Terrain']);
loadGlobalScript('js/keyboard-nav.js', ['KeyboardNav']);
loadGlobalScript('js/data-fetcher.js', ['DataFetcher']);
loadGlobalScript('js/precomputed-scores.js', ['PrecomputedScores']);
loadGlobalScript('js/score-choropleth.js', ['ScoreChoropleth']);
loadGlobalScript('js/city-selector.js', ['CitySelector']);
loadGlobalScript('js/data-status.js', ['DataStatus']);
loadGlobalScript('js/crash-guard.js', ['CrashGuard']);
loadGlobalScript('js/cell-store.js', ['CellStore']);
loadGlobalScript('js/cell-layers.js', ['CellLayers']);
loadGlobalScript('js/cell-hierarchy.js', ['CellHierarchy']);
loadGlobalScript('js/cell-ingest.js', ['CellIngest']);
loadGlobalScript('js/cell-profile.js', ['CellProfile']);
loadGlobalScript('js/time-slider.js', ['TimeSlider']);
loadGlobalScript('js/analysis.js', ['Analysis']);
loadGlobalScript('js/analyses-panel.js', ['AnalysesPanel']);
loadGlobalScript('js/urban-insights.js', ['UrbanInsights']);
loadGlobalScript('js/urban-lenses.js', ['UrbanLenses']);
loadGlobalScript('js/urban-agents.js', ['UrbanAgents']);
loadGlobalScript('js/lenses-panel.js', ['LensesPanel']);
loadGlobalScript('js/scenario-lenses.js', ['ScenarioLenses']);
loadGlobalScript('js/intel-brief.js', ['IntelBrief']);
loadGlobalScript('js/insights-panel.js', ['InsightsPanel']);
loadGlobalScript('js/agents-panel.js', ['AgentsPanel']);
loadGlobalScript('js/disha-intel.js', ['DishaIntel']);
loadGlobalScript('js/growth-score.js', ['GrowthScore']);
loadGlobalScript('js/realtime-growth.js', ['RealtimeGrowth']);
loadGlobalScript('js/growth-widget.js', ['GrowthWidget']);
loadGlobalScript('js/growth-overlay.js', ['GrowthOverlay']);
loadGlobalScript('js/ca-growth-overlay.js', ['CAGrowthOverlay']);
loadGlobalScript('js/traffic-score.js', ['TrafficScore']);
loadGlobalScript('js/traffic-grid.js', ['TrafficGrid']);
loadGlobalScript('js/realtime-traffic.js', ['RealtimeTraffic']);
loadGlobalScript('js/traffic-widget.js', ['TrafficWidget']);
loadGlobalScript('js/traffic-overlay.js', ['TrafficOverlay']);
loadGlobalScript('js/mobility-score.js', ['MobilityScore']);
loadGlobalScript('js/mobility-grid.js', ['MobilityGrid']);
loadGlobalScript('js/emergency-access-score.js', ['EmergencyAccessScore']);
loadGlobalScript('js/emergency-access.js', ['EmergencyAccess']);
loadGlobalScript('js/realtime-mobility.js', ['RealtimeMobility']);
loadGlobalScript('js/mobility-widget.js', ['MobilityWidget']);
loadGlobalScript('js/mobility-overlay.js', ['MobilityOverlay']);
loadGlobalScript('js/emergency-access-overlay.js', ['EmergencyAccessOverlay']);
loadGlobalScript('js/utilities.js', ['Utilities']);
loadGlobalScript('js/scenario-model.js', ['ScenarioModel']);
loadGlobalScript('js/area-aggregate.js', ['AreaAggregate']);
loadGlobalScript('js/compare.js', ['Compare']);
loadGlobalScript('js/heat-score.js', ['HeatScore']);
loadGlobalScript('js/heat-widget.js', ['HeatWidget']);
loadGlobalScript('js/flood-scs.js', ['FloodSCS']);
loadGlobalScript('js/realtime-flood.js', ['RealtimeFlood']);
loadGlobalScript('js/flood-inundation.js', ['FloodInundation']);
loadGlobalScript('js/realtime-alerts.js', ['RealtimeAlerts']);
loadGlobalScript('js/realtime-quakes.js', ['RealtimeQuakes']);
loadGlobalScript('js/realtime-imd.js', ['RealtimeIMD']);
loadGlobalScript('js/realtime-heat.js', ['RealtimeHeat']);
loadGlobalScript('js/data-fetcher-cache.js', ['DataFetcherCache']);
loadGlobalScript('js/training-data-gen.js', ['TrainingDataGen']);
loadGlobalScript('js/disha-providers.js', ['DISHAProviders']);
loadGlobalScript('js/bivariate-overlay.js', ['BivariateOverlay']);
loadGlobalScript('js/ndvi-overlay.js', ['NDVIOverlay']);
loadGlobalScript('js/viewshed.js', ['Viewshed']);
loadGlobalScript('js/terrain-hydrology.js', ['TerrainHydrology']);
loadGlobalScript('js/layer-swipe.js', ['LayerSwipe']);
loadGlobalScript('js/sentinel-imagery.js', ['SentinelImagery']);
loadGlobalScript('js/point-cloud.js', ['PointCloud']);
loadGlobalScript('js/kde-overlay.js', ['KDEOverlay']);
loadGlobalScript('js/accessibility-overlay.js', ['AccessibilityOverlay']);
loadGlobalScript('js/dtdl-export.js', ['DTDLExport']);
loadGlobalScript('js/real-estate-model.js', ['RealEstateModel']);
loadGlobalScript('js/footprint-grid.js', ['FootprintGrid']);
loadGlobalScript('js/query-engine.js', ['QueryEngine']);
loadGlobalScript('js/disha.js', ['DISHA']);
loadGlobalScript('js/disha-actions.js', ['DISHAActions']);
loadGlobalScript('js/disha-tools.js', ['DISHATools']);
loadGlobalScript('js/disha-agent.js', ['DISHAAgent']);
loadGlobalScript('js/text2map.js', ['Text2Map']);
loadGlobalScript('js/text2map-results-layer.js', ['Text2MapResultsLayer']);
loadGlobalScript('js/provenance.js', ['Provenance']);
loadGlobalScript('js/map-snapshot.js', ['MapSnapshot']);
loadGlobalScript('js/open-data-finder.js', ['OpenDataFinder']);
loadGlobalScript('js/disha-mentions.js', ['DishaMentions']);
loadGlobalScript('js/url-state.js', ['URLState']);
loadGlobalScript('js/theme.js', ['Theme']);
loadGlobalScript('js/i18n-ui.js', ['I18nUI']);
loadGlobalScript('js/i18n.js', ['I18n']);
loadGlobalScript('js/digital-twin-layers.js', ['DigitalTwinLayers']);
loadGlobalScript('js/saved-views.js', ['SavedViews']);
loadGlobalScript('js/layers-panel.js', ['LayersPanel']);
loadGlobalScript('js/export-dialog.js', ['ExportDialog']);
loadGlobalScript('js/bookmarks.js', ['Bookmarks']);
loadGlobalScript('js/building-intelligence.js', ['BuildingIntelligence']);
loadGlobalScript('js/buildings-deck.js', ['DeckBuildings']);
loadGlobalScript('js/building-data.js', ['BuildingData']);
loadGlobalScript('js/overture-buildings.js', ['OvertureBuildings']);
loadGlobalScript('js/floating-dialogs.js', ['FloatingDialogs']);
loadGlobalScript('js/onboarding.js', ['Onboarding']);
loadGlobalScript('js/text2map-embeddings.js', ['Text2MapEmbeddings']);
loadGlobalScript('js/pitch-map.js', ['PitchMap']);
loadGlobalScript('js/quality-3d.js', ['Quality3D']);
loadGlobalScript('js/sun-shadows.js', ['SunShadows']);
loadGlobalScript('js/sun-study.js', ['SunStudy']);
loadGlobalScript('js/camera-presets.js', ['CameraPresets']);
loadGlobalScript('js/view-handoff.js', ['ViewHandoff']);
loadGlobalScript('js/sun-hours.js', ['SunHours']);
loadGlobalScript('js/floor-area.js', ['FloorArea']);
loadGlobalScript('js/gltf-export.js', ['GltfExport']);
loadGlobalScript('js/footprint-export.js', ['FootprintExport']);
loadGlobalScript('js/site-brief.js', ['SiteBrief']);
loadGlobalScript('js/measure-tool.js', ['MeasureTool']);
loadGlobalScript('js/present-mode.js', ['PresentMode']);
loadGlobalScript('js/annotations.js', ['Annotations']);
loadGlobalScript('js/ui-polish.js', ['UIPolish']);
loadGlobalScript('js/trees-3d.js', ['Trees3D']);
loadGlobalScript('js/city-overview.js', ['CityOverview']);
