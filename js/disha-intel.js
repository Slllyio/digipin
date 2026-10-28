/**
 * DishaIntel — grounds DISHA in the cell store (js/urban-insights.js).
 *
 *   match(question)        routes "what's notable here", "what if we add a
 *                          park / double density / it floods", "compare
 *                          Indore with Pune" and "rank the cities" to the
 *                          deterministic engine, so they answer offline too
 *   answer(el, intent, ctx) renders that answer as cards in the chat and
 *                          returns its plain text for the model to narrate
 *   evidence(cell)         the cited [C#] evidence block for the selected cell
 *   decorate(el, cites)    turns [C#] tags in a reply into source-card chips
 *
 * match() and citeTags() are pure and unit-tested.
 */
const DishaIntel = (() => {
    const RE = {
        insights: /\b(what('?s| is)? (notable|special|unusual|interesting)|stands? out|insights?|hotspots?|anomal(y|ies)|what('?s| is) (going on|happening)|trends? (here|in this))\b/i,
        cool: /\b(plant(ing)?|add(ing)?|more)\b.{0,20}\btrees?\b|\btree cover\b|\bcool(ing)? (down )?(the |this )?(area|street|neighbourhood|neighborhood|city)\b/i,
        closure: /\b(close|closing|closed|shut(ting)?|block(ed|ing)?)\b.{0,25}\b(road|roads|street|junction|flyover|bridge)\b|\broad closure\b/i,
        park: /\b(add(ing)?|new|build(ing)?|create|plant(ing)?)\b.{0,20}\b(park|garden|green space|forest)\b|\bpark here\b/i,
        density: /\b(double|triple|more|increase|densif\w*|(\d(\.\d)?)\s*x)\b.{0,25}\b(density|population|residents|people|housing|homes|units)\b/i,
        flood: /\b(flood(s|ed|ing)? (event|scenario|hits?|happens?)|if it floods|heavy rain|cloudburst|(severe|extreme|moderate) flood|inundat\w*)\b/i,
        dashboard: /\b(rank(ing|ed)? (the )?cities|which city is (best|better|most|least)|city (dashboard|rankings?|league)|best city|compare (all )?cities)\b/i,
        compare: /\b(compare|vs\.?|versus|better than)\b/i,
        // Urban lenses (js/urban-lenses.js): combined-dataset questions about people.
        lens: {
            crowds: /\b(crowds?|crowded (places|zones?|areas?)|stampedes?|festival (crowds?|rush)|mass gatherings?|processions?)\b/i,
            airport: /\b((drive|travel|time|distance|far|long|get(ting)?) (to|from) (the )?airport|airport (access|drive|commute|connectivity|travel time)|close (to|by) (the )?airport)\b/i,
            builduse: /\b(building use|land use (map|class\w*)|what (are|is) (the )?(buildings?|blocks?) used for|residential or commercial|commercial or residential|which (blocks|areas) are (residential|commercial|industrial))\b/i,
            views: /\b(sea[- ]?(facing|views?)|lake[- ]?(facing|views?)|park[- ]?(facing|views?)|river[- ]?(facing|views?)|views? (of|over) the (sea|lake|park|river)|rooms? with a view|flats? with (a )?views?|best views?)\b/i,
            railgates: /\b(level crossings?|railway (gates?|crossings?)|railroad crossings?|rail(way)? fatak|phatak|road over ?bridges?|rail over ?bridges?|robs?|rubs?|road under ?bridges?)\b/i,
            schoolgap: /\b(school (gaps?|access|deserts?|seats?|shortages?)|(children|kids)\b.{0,40}\bno schools?|no schools? (within|near(by)?)|schools? within (1|one|walking) ?(km|distance)|right to education|rte norms?|school[- ]age children)\b/i,
            wildedge: /\b(leopards?|wild ?life conflict|human[- ]wildlife|forest edges?|snake ?bites?|wild animals?|homes? (near|next to|beside) (the )?forests?)\b/i,
            powercuts: /\b(power ?cuts?|power outages?|blackouts?|load[- ]?shedding|(lose|losing|without) (power|electricity)|electricity (cuts?|outages?|supply|reliability)|unreliable (power|electricity))\b/i,
            dumpsmoke: /\b(downwind of\b.{0,20}\b(landfills?|dumps?|garbage|factor(y|ies)|industr\w*)|landfill (smoke|smell|odou?r|fires?)|garbage (smoke|smell|odou?r)|dump(ing)? (site )?(smoke|smell|odou?r|fires?)|smell from\b.{0,20}\b(landfills?|dumps?))\b/i,
            binreach: /\b((waste|garbage|dust|trash|litter) ?bins?|dumper bins?|dustbins?)\b.{0,30}\b(near|nearby|missing|no|lack\w*|where|reach|access|enough|gaps?)\b|\b(no|without|need\w*|more|missing) (public )?(waste |garbage |dust)?bins?\b/i,
            wellrisk: /\b(bore ?wells?|tube ?wells?)\b.{0,40}\b(contaminat\w*|septic|sewage|safe|polluted|test\w*|quality|risk)\b|\b(public bore ?wells?|bwssb bore ?wells?|bore ?wells? near (septic|sewage))\b/i,
            lastrites: /\b(cremat\w+|crematori(um|a)s?|burial grounds?|cemeter(y|ies)|graveyards?|kabrastan|qabristan|shmashan\w*|smashan\w*|funeral (sites?|grounds?))\b/i,
            roadplan: /\b(road widening|widen(ing)? (the |of )?roads?|roads? (to be |being )?widen\w*|master plan roads?|rmp( 2015)? roads?|planned (road|right of way) widths?|proposed (link )?roads?|new link roads?)\b/i,
            sewergap: /\b(sewers?|sewerage|underground drainage|ugd|septic tanks?|soak pits?)\b.{0,30}\b(gaps?|missing|no|lack\w*|coverage|connections?|network|where|not connected)\b|\b(no|without|unsewered|lack of) (sewers?|sewerage|sewer lines?|underground drainage)\b/i,
            canteen: /\b(indira canteens?|amma (unavagams?|canteens?)|annapurna (meals?|canteens?|centres?)|(subsidi[sz]ed|cheap|public|government|₹ ?5|rs\.? ?5) (canteens?|meals?|food)|community kitchens?)\b/i,
            pondcensus: /\b(water ?bod(y|ies) census|census of water ?bodies|(ponds?|tanks?|johads?|water ?bod(y|ies))\b.{0,25}\b(not in use|disused|reviv\w+|rejuvenat\w+|restor\w+)|(revive|rejuvenate|restore) (the )?(ponds?|tanks?|johads?|water ?bod(y|ies))|amrit sarovar|encroached (ponds?|tanks?|water ?bod(y|ies)))\b/i,
            streetpoles: /\b(street ?light (poles?|survey|counts?|density|coverage|gaps?)|(how many|number of|count of) street ?lights?|street ?lights? per (km|kilometre)|led (street ?)?lights?|light poles?)\b/i,
            firereach: /\b(fire stations? (reach|coverage|cover|response|gaps?|deserts?|access)|(new|next|more) fire stations?|fire (response|cover(age)?) times?|fire (service|brigade) (reach|coverage|response))\b/i,
            treecensus: /\b(tree census|trees? counts?|counted trees|census trees|invasive (trees?|species|exotics?)|subabul|prosopis|leucaena|single[- ]species|monoculture|(big|old|heritage|giant) (old )?trees|trees? per (person|resident|capita|head|100))\b/i,
            crashrecord: /\b((road |traffic )?(crash|accident)\w* (data|records?|statistics|stats|numbers|counts?|by (police )?station)|(fatal|road) (crashes|accidents) (recorded|reported|rising|by area)|(most|where) (fatal |road )?(crashes|accidents) (happen|occur)|accident[- ]prone (areas?|zones?|stations?)|btp)\b/i,
            slummap: /\b(slum (maps?|boundar\w*|lists?)|mapped slums?|(non[- ])?notified slums?|official slums?|declared slums?)\b/i,
            turnout: /\b(voter )?turnout|\b(who|how many( people)?) (voted|didn'?t vote)|\bnota\b|\b(voting|polling) (percentage|rate)|\blow voting\b/i,
            freeclinic: /\b(free (clinics?|health ?care|doctors?|treatment)|(government|govt|public|municipal) (clinics?|dispensar\w*|health (centres?|centers?))|uphcs?|primary health (centres?|centers?)|phcs?|namma clinics?|mohalla clinics?|basti dawakhanas?)\b/i,
            anganwadi: /\b(anganwadis?|anganwadi centres?|icds|balwadis?|creches?|day ?care for (poor )?(children|kids))\b/i,
            schoolstrain: /\b(udise|pupil[- ]teacher ratios?|(pupils|students) per teacher|teacher shortages?|overcrowded (government |govt |sarkari )?(schools?|classrooms?)|(government|govt|sarkari|public) schools? (quality|condition|strain|infrastructure|toilets?)|schools? (without|with no|lacking) (girls'? )?toilets?|girls'? toilets? in schools?|classrooms? (in|needing|need) (major )?repair)\b/i,
            floodagain: /\b(flooded (before|again|repeatedly|in (2005|2015|2020))|(past|previous|historic(al)?|repeat(ed)?|recurring) flood\w*|flood (history|hotspots?|spots?)|(2005|2015) floods?|nivar)\b/i,
            districthealth: /\b(nfhs|stunt(ed|ing)|wasting|anaemi\w*|anemi\w*|malnutrition|malnourish\w*|blood pressure|hypertension|diabet\w*|blood sugar|health insurance|district health|child health)\b/i,
            kilnsmoke: /\b(brick ?kilns?|bhattas?|bhatta|kiln (smoke|pollution|belt)|zig ?zag kilns?)\b/i,
            coalplume: /\b(coal (power )?(plants?|stations?|smoke|plumes?)|thermal (power )?(plants?|stations?)|power plants?\b.{0,30}\b(smoke|pollut\w*|downwind|upwind|plumes?)|downwind of\b.{0,30}\bplants?|fly ?ash|so2|so₂|sulph(ur|ate) dioxide)\b/i,
            carekit: /\b(diagnostic (labs?|centres?|centers?)|path(ology)? labs?|blood tests?|scan (centres?|centers?)|mri|ct scans?|x-?rays?|dentists?|dental|eye (clinics?|care|doctors?|hospitals?)|ophthalmolog\w*|cataract\w*|optometrists?|old[- ]age homes?)\b/i,
            fuelsafe: /\b(petrol (pumps?|stations?)|fuel (stations?|pumps?)|cng (stations?|pumps?)|gas stations?)\b/i,
            heritagesafe: /\b(monuments?|heritage( sites?| buildings?| structures?)?|forts?|havelis?)\b.{0,40}\b(at risk|risks?|flood\w*|earthquakes?|hazards?|damage\w*|danger\w*|safe(ty)?)\b/i,
            quarries: /\b(quarr(y|ies)|quarry pits?|stone crush\w*|mining pits?|flooded pits?)\b/i,
            hotelfire: /\b(hotels?|guest ?houses?|lodges?|budget hotels?)\b.{0,40}\b(fires?|fire safety|fire risk|fire nocs?)\b|\b(fires?|fire safety)\b.{0,30}\b(hotels?|guest ?houses?)\b|\barpit palace\b/i,
            sitedust: /\b(construction|building sites?|sites?)\b.{0,30}\b(dust)\b|\bdust\b.{0,30}\b(construction|building sites?)\b|\b(construction|building site) (workers?|labou?rers?)\b.{0,30}\b(heat|hot)\b/i,
            rainharvest: /\b(rain\s?water harvest\w*|rooftop (rain|harvest\w*)|harvest\w* (rain|rainwater)|rwh)\b/i,
            coaching: /\b(coaching (centres?|centers?|hubs?|institutes?|classes)|tuition (centres?|hubs?)|(pg|paying guest|student) hostels?|basement (librar(y|ies)|classes|flood\w*))\b.{0,40}\b(safe\w*|fires?|flood\w*|hazards?|risk\w*|basements?)\b|\b(mukherjee nagar|rajinder nagar)\b/i,
            gridflood: /\b(sub-?stations?|power (grid|supply)|electricity|power cuts?|blackouts?|outages?)\b.{0,40}\b(flood\w*|waterlog\w*|under water|inundat\w*)\b|\b(flood\w*|waterlog\w*)\b.{0,30}\b(sub-?stations?|blackouts?|power cuts?|outages?)\b/i,
            treefall: /\b(tree[\s-]?falls?|trees? (falling|fall(ing)? on|uproot\w*|collaps\w*)|fallen trees?|uprooted trees?|(tree )?prun(e|ing)|trees?\b.{0,30}\b(monsoon|storms?)\b.{0,20}\b(roads?|fall))\b/i,
            walkups: /\b(walk[\s-]?ups?|no lifts?|without (a )?lifts?|no elevators?|without (an )?elevators?|stairs?)\b.{0,40}\b(elderly|old(er)? (people|residents)|seniors?|aged)\b|\b(elderly|old(er)? (people|residents)|seniors?|senior citizens)\b.{0,40}\b(walk[\s-]?ups?|stairs?|lifts?|elevators?|upper floors?)\b/i,
            stationload: /\b(local trains?|mumbai locals?|suburban (rail|railway|trains?|stations?)|(crowded|busiest|overcrowded) (local |rail(way)? |train |suburban )?stations?|station crowding)\b/i,
            hospitalsafe: /\b(hospital safety|safe(st)? hospitals?|unsafe hospitals?|hospitals?\b.{0,30}\b(hazards?|disasters?|earthquakes?|unsafe|at risk|risky))\b/i,
            schoolsafe: /\b(school safety|safe(st)? schools?|unsafe schools?|schools?\b.{0,30}\b(hazards?|disasters?|floods?|earthquakes?|unsafe|at risk|risky))\b/i,
            firelanes: /\b(fire (engines?|tenders?|brigades?|trucks?)|fire ?fighters?)\b.{0,40}\b(reach|access|enter|lanes?|gall(y|ies)|narrow|get (in|to))\b|\b(narrow (lanes?|gall(y|ies)|streets?))\b.{0,30}\bfires?\b/i,
            refuge: /\b(cyclone|storm[\s-]?surge|surge)\b.{0,30}\b(shelters?|refuges?|evacuat\w*|relief camps?)\b|\b(shelters?|refuges?|evacuat\w*)\b.{0,30}\b(cyclones?|storm[\s-]?surge)\b/i,
            factoryhomes: /\b(factor(y|ies)|industr(y|ies|ial (units?|areas?|estates?))|workshops?)\b.{0,40}\b(homes?|houses?|housing|residential|residents|neighbou?rhoods?)\b|\b(homes?|houses?|housing|residential|residents)\b.{0,30}\b(beside|next to|near|among|inside)\b.{0,15}\b(factor(y|ies)|industr\w*)\b|\bnon-?conforming (industr\w*|units?)\b/i,
            quake: /\b(liquef\w*|microzonation|seismic amplif\w*|earthquake shaking|shak\w* (the )?(hardest|most) in an earthquake|soft (ground|soil)\b.{0,30}\bearthquakes?|earthquakes?\b.{0,40}\b(soft (ground|soil)|sandy|tall buildings?|high-?rises?|amplif\w*))\b/i,
            critwater: /^(?!.*\b(cut off|stranded|isolated|lose access|cannot reach)\b).*?(?:\b(hospitals?|fire stations?|police stations?|emergency services|critical (facilities|infrastructure))\b.{0,40}\b(flood\w*|waterlog\w*|inundat\w*|under water)\b|\b(flood\w*|waterlog\w*)\b.{0,30}\b(hospitals?|fire stations?|emergency services)\b)/i,
            oldtall: /\b(structural(ly)? (audits?|safety|unsafe)|dangerous (old )?buildings?|unsafe (old )?buildings?|buildings? collapses?|collapse risk|old (and |, )?tall buildings?|old buildings?\b.{0,30}\b(audit|unsafe|collapse|earthquake))\b/i,
            marketfire: /\b(markets?|bazaars?)\b.{0,30}\bfire\b|\b(market fires?|fire (risk|hazard|safety) (in|of) (the )?(markets?|bazaars?)|(markets?|bazaars?) fire (risk|hazard|safety)|fire audit)\b/i,
            events: /\b(banquet halls?|marriage (halls?|gardens?)|wedding (season|venues?|halls?|traffic|processions?)|baraat|event venues?)\b/i,
            mothercare: /\b(maternity|gyn(a)?ecolog\w*|obstetric\w*|p(a)?ediatric\w*|child(ren)?'?s? doctors?|antenatal|pregnan\w*|mother and child|newborns?)\b/i,
            railnoise: /\b(train noise|railway noise|rail noise|(near|beside|next to|along) (the )?(railway|railway lines?|rail lines?|train tracks?|tracks)|live (near|by) (the )?(railway|tracks))\b/i,
            riders: /\b(delivery (riders?|boys?|partners?|workers?|executives?)|gig (workers?|economy|work)|riders? (rest|hubs?|stops?)|swiggy|zomato|blinkit|zepto|quick[- ]commerce|dark stores?)\b/i,
            cyclone: /\b(cyclones?|cyclonic|hurricanes?|typhoons?|storm winds?|wind (risk|speed|load|zones?)|is ?875)\b/i,
            shadecare: /\b(shad(e|ed|y) (walk|route|path)s? to (the )?(clinic|hospital|pharmac(y|ies)|doctor|health ?care)|walk(ing)? to (the )?(clinic|hospital|pharmacy|doctor) in the (sun|heat)|sun on the way to (the )?(clinic|hospital|doctor))\b/i,
            techhubs: /\b(tech (hubs?|parks?|clusters?|corridors?)|it (parks?|hubs?|corridors?|clusters?|companies|firms)|software (companies|firms|parks?)|sez|special economic zones?|startup (hubs?|clusters?))\b/i,
            packed: /\b(packed (blocks?|buildings?|areas?)|wall[\s-]to[\s-]wall|no setbacks?|setbacks?|ground coverage|over[\s-]?(built|crowded) (blocks?|lanes?|areas?)|fire[\s-]?tender access)\b/i,
            coast: /\b(coast(line|al) (change|erosion|regulation|zone)|crz|reclaim(ed|ation)|land (reclaimed|from the sea)|shoreline|sea (erosion|encroach\w*))\b/i,
            tourism: /\b(touris(ts?|m)|visitor (magnets?|spots?|attractions?|hotspots?)|landmarks?|sightseeing|where do visitors go)\b/i,
            cityfarms: /\b(farm ?land (left |inside |in )|farms? (inside|within|in) the city|urban (agriculture|farms?|farming)|allotments?|orchards?|plant nurser(y|ies))\b/i,
            drainage: /\b(nall?ahs?|open drains?|storm[\s-]?water drains?|drainage (network|gaps?|density)|no drains?|sewage (treatment|plants?)|stps?|effluent)\b/i,
            toilets: /\b((public|community) (toilets?|restrooms?|urinals?)|toilets?|restrooms?|drinking[\s-]?water (points?|taps?|fountains?)|water (taps?|points?) (on|in) the street)\b/i,
            gated: /\b(gated (communit(y|ies)|colon(y|ies)|societ(y|ies)|streets?|areas?)|(street|colony|road) (gates?|barriers?)|closed (streets?|roads?|colon(y|ies)))\b/i,
            powerlines: /\b((high[\s-]?(voltage|tension)|ht|hv|transmission|power|electricity|pylon|tower) lines?|pylons?|transmission towers?|(power|electric(al)?) (sub[\s-]?stations?|corridors?)|under the (wires|power lines?))\b/i,
            gardens: /\b(soil (is |good |suitable )*for (gardens?|gardening|growing|farming|plants?|vegetables)|garden soil|soil (ph|quality|fertility|health)|kitchen gardens?|community gardens?|urban farm(s|ing)?|terrace gardens?)\b/i,
            cooling: /\b(cooling (centres?|centers?|shelters?|spaces?)|heat (shelters?|refuges?)|cool (shelters?|spaces?|refuges?))\b/i,
            buildingage: /\b(how old is|building age|old(est)? (buildings?|neighbou?rhoods?|areas?)|when was .{0,20}built|built (before|after) (19|20)\d\d)\b/i,
            mosquito: /\b(mosquito\w*|dengue|chikungunya|aedes|malaria|vector[\s-]borne)\b/i,
            greenbelt: /\b(ridge|reserve forests?|national parks?|(wildlife )?sanctuar(y|ies)|eco[\s-]?sensitive zones?|esz|protected (forests?|areas?|land))\b/i,
            monthly: /\b(year[\s-]on[\s-]year (changes?|signs?)|compared? (with|to) (a|last) year ago|new (construction|building) this (month|year)|lights? (came|coming) on)\b/i,
            reach: /\b(post offices?|police stations?|fire stations?|pharmac(y|ies)|chemists?|grocer(y|ies|s)?|kirana|preschools?|cr[eè]ches?|day ?care)\b.{0,40}\b(far|near(by)?|reach|access|missing|lack\w*|gaps?|distance|within)\b|\b(far|lack\w*|no|missing)\b.{0,25}\b(post offices?|police stations?|fire stations?|pharmac(y|ies)|grocer(y|ies|s)?|preschools?)\b/i,
            landmix: /\b(land[\s-]?use mix|mixed[\s-]use|(homes?|houses?|people|residents?) (next to|near|beside) (industr\w*|factor(y|ies))|industrial (areas?|zones?) (near|next to) (homes?|houses?))\b/i,
            heritage: /\b(monuments?|heritage (zones?|limits?|sites?|buildings?)|asi (zones?|limits?|restrictions?|noc|rules?)|prohibited (area|zone)|regulated (area|zone)|nma (permission|noc)|amasr)\b/i,
            dumps: /\b(landfills?|dump ?(sites?|yards?)|garbage (mountains?|dumps?)|quarr(y|ies)|kachra)\b/i,
            waterloss: /\b(when (did|were|was) .{0,30}\b(lakes?|ponds?|tanks?|water ?bodies)|(lakes?|ponds?|tanks?|water ?bodies)\b.{0,25}\b(by (year|decade)|since (19|20)\d\d)|lost lakes? (timeline|history))\b/i,
            encroach: /\b(encroach\w*|(lakes?|ponds?|wetlands?|water ?bodies|floodplains?|green belts?|ridge|forests?)\b.{0,30}\b(lost|built (on|over)|disappear\w*|filled|encroached|destroyed)|(lost|disappearing|vanishing) (lakes?|ponds?|wetlands?|water ?bodies))\b/i,
            floodloss: /\b(flood (damage|losses?|cost)|expected (annual )?(damage|loss)|climate risk to (property|buildings|homes)|(property|buildings?|homes?|real estate)\b.{0,25}\b(climate|flood) risk|value at risk|insur\w*)\b/i,
            housinggap: /\b(housing (gap|shortages?|deficits?|demand|need)|shortage of (homes|housing)|enough (homes|housing)|(homes|houses|housing) (needed|required) by 2030|how many (homes|houses) (are )?needed)\b/i,
            coolroof: /\b(cool[\s-]?roofs?|white[\s-]?(roofs?|paint\w*|wash\w*)|roof (albedo|colou?r|paint\w*|coating)|dark roofs?|(tin|metal|concrete) roofs?\b.{0,20}\b(hot|heat)|reflective (roofs?|paint|coating))\b/i,
            jobsmap: /\b(where (are|is) (the )?jobs|employment (centres?|centers?|hubs?|density)|job (density|hubs?|centres?|map)|bedroom (areas?|suburbs?|communit\w*)|jobs[\s-]?(housing|homes) balance|business districts?|cbd)\b/i,
            lakehealth: /\b(lakes?|ponds?|tanks?|reservoirs?)\b.{0,30}\b(health|algae|algal|weeds?|hyacinth|froth\w*|foam\w*|shrink\w*|shrank|dying|polluted|green|dry(ing)?)\b|\b(lake|water) (quality|health)\b/i,
            stay: /\b(hotel (gaps?|demand|opportunit(y|ies)|sites?)|where (to|should (we|i)) (build|open) an? (hotel|guest ?house|serviced apartment)|serviced apartments?|hospitality demand)\b/i,
            recharge: /\b(groundwater recharge|recharge (pits?|wells?|ponds?|zones?|sites?)|rain ?water harvesting (sites?|potential)|where (should|to) (we )?recharge)\b/i,
            lightning: /\b(lightning|thunder ?storms?|thunderbolts?|bijli gir)\b/i,
            anchors: /\b(student (housing|hubs?|areas?|accommodation)|co[\s-]?living|pg (accommodation|demand)|paying guest|coaching (hubs?|centres?|centers?)|rental demand (drivers?|anchors?)|near (colleges|hospitals))\b/i,
            services: /\b(banking deserts?|no (bank|atm|clinic|pharmacy|chemist|school)s? (nearby|within|near)|(banks?|atms?|clinics?|pharmac\w+|chemists?) (per|within|near(by)?|access)|everyday services|basic services)\b/i,
            flightpath: /\b(flight ?paths?|aircraft noise|airport noise|planes? (fly|flying) (over|low)|under the (flight|approach)|approach path|overflights?|low[\s-]?flying (planes?|aircraft))\b/i,
            floorspace: /\b(commercial|office|retail|non[\s-]?residential) (floor ?space|floor area|stock|space supply)|(floor ?space|floor area) (for|of) (offices|shops|commerce)|grade a office\b/i,
            ghost: /\b(ghost (towns?|cit(y|ies)|towers?|buildings?|blocks?)|empty (flats|apartments|towers|buildings|new buildings)|unsold (flats|homes|inventory|apartments)|unoccupied|vacant (flats|apartments|towers|buildings))\b/i,
            informal: /\b(slums?|informal (housing|settlements?|colonies)|jhuggis?|bastis?|chawls?|unauthori[sz]ed colonies)\b/i,
            sites: /\b(stalled|stuck|abandoned|half[\s-]?built|unfinished) (construction|projects?|sites?|buildings?)|construction sites?\b/i,
            catchment: /\b((retail|shop\w*|market|mall) catchments?|catchments? of (the )?(shops|malls|markets)|trade areas?|huff model|shopping (centres?|centers?|districts?) (draw|serve|catchment)|room for (more )?shops|retail (catchment|gravity|pull))\b/i,
            nighteconomy: /\b(night ?life|night[\s-]?time economy|night economy|night districts?|late[\s-]?night (food|eat\w*|places|spots|economy)|open late|awake at night|party (areas?|spots?))\b/i,
            runoff: /\b(storm ?water|run[\s-]?off|drains? (overflow|capacity|can\W?t cope)|permeable (paving|surfaces?)|rain gardens?|sponge city|sealed (ground|surfaces?)|impervious (surfaces?|cover))\b/i,
            mangrove: /\bmangroves?\b/i,
            parkshare: /\b(park|green|open) (space|area)s? (per (person|resident|head|capita)|shortage|deficit|gap)|(enough|lack of|short of|no|few) parks?\b|parks? per (person|resident|capita)|park deserts?\b/i,
            airdeaths: /\b(deaths?|die|dying|mortality|kill\w*|lives (lost|saved))\b.{0,40}\b(air|pollution|pm ?2\.?5|smog)\b|\b(air|pollution|pm ?2\.?5|smog)\b.{0,30}\b(deaths?|mortality|kills?|killing)\b/i,
            market: /\b(property|real[\s-]?estate|housing) market (activity|hot\w*|busy|busiest)|(hot|busiest|emerging|active) (property |real[\s-]?estate )?markets?\b|estate agents?|property (dealers?|brokers?|agents?)|brokers? density\b/i,
            farmloss: /\b(farm ?land|crop ?land|agricultur\w* land|farms)\b.{0,30}\b(lost|loss|losing|built|eaten|disappear\w*|conver\w*|gone)\b|(lost|losing|loss of) (farm ?land|farms|crop ?land|agricultur\w* land)|urban (edge|fringe|sprawl into farm\w*)|peri[\s-]?urban\b/i,
            treeplant: /\b(plant(ing)? (trees|saplings)|tree[\s-]?planting|how many trees|trees? (needed|to plant)|afforest\w*|urban forest\w*|miyawaki)\b/i,
            ground: /\b(black cotton|expansive (soil|clay)|soil (test|type|conditions?|for (building|construction|foundations?))|ground conditions?|foundations?|seismic|earthquake (zone|risk)|bearing capacity)\b/i,
            burning: /\b(open burning|(garbage|waste|trash|stubble|crop[\s-]?residue|parali|landfill) (burning|fires?)|burning (garbage|waste|stubble|crop)|fires? (near|around)|active fires?|firms)\b/i,
            airtrend: /\b(air (getting|got|becoming) (better|worse|cleaner|dirtier)|(cleaner|dirtier) air|air (quality )?trend|pollution (trend|rising|falling|getting (better|worse))|no2 (trend|since|rise|fall)|sulph?ur dioxide|\bso2\b)\b/i,
            change: /\b(changed (the )?most|changing (fastest|most|now)|change (detection|since \d{4})|since 2017|before and after|new (development|construction) since)\b/i,
            vitality: /\b(high streets?|commercial (vitality|activity|hubs?|areas?|streets?)|busiest (market|street|area)s?|retail (gap|desert|opportunit\w*)|(shops|businesses|restaurants|offices) (per|density)|chains?|brands? presence)\b/i,
            riskygrowth: /\b((new|recent) (building|construction|development|projects?|homes)\b.{0,30}\b(flood|risk|danger|unsafe|climate)\w*|building (in|on) (flood|risky|unsafe)\w*|risky (growth|development|construction)|maladaptive)\b/i,
            climategrade: /\b(climate (risk|grade|score|rating|resilien\w*|exposure)|climate[\s-]?(proof|safe)|future[\s-]?proof|safest (area|place|neighbou?rhood|block)s? (from|for) (climate|2050))\b/i,
            waterrisk: /\b(water (stress|scarcity|shortage|crisis|security|risk|supply)|groundwater|ground water|water table|borewell\w*|tankers?|run(ning)? out of water|day zero|drought)\b/i,
            solarhome: /\b((home|house|my|household|residential)\b.{0,15}\bsolar|solar\b.{0,25}\b(payback|subsidy|pay back|worth it|per home|homes|households?|save|savings)|surya ghar|rooftop solar\b.{0,20}\b(ac|air[\s-]?condition\w*)|net[\s-]?meter\w*)\b/i,
            flood2050: /\b(sea[\s-]?level( rise)?|coastal flood\w*|storm surge|(flood\w*|inundat\w*|under ?water|submerged?)\b.{0,25}\b(2050|2030|2080|future|climate change)|(2050|future)\b.{0,20}\bflood\w*|sinking (land|city)|subsidence)\b/i,
            streetheat: /\b((street|block|neighbou?rhood|local)[\s-]?(level )?heat (in |by )?(2050|future)|heat island (in |by )?2050|cooling (need|demand|degree[\s-]?days)|(ac|air[\s-]?condition\w*) demand)\b/i,
            climate2050: /\b(2050|2040s|mid[\s-]?century|climate (change|projections?|future)|future (climate|heat|temperatures?)|how (much )?hotter|global warming|cmip6?|ssp[\s-]?[1-5])\b/i,
            metroboost: /\b((upcoming|new|future|under[\s-]construction|planned|proposed) metro|metro (line|station|extension)s? (coming|under construction|planned|proposed)|metro (uplift|impact on (prices|property|land))|(property|land) (value|prices?) .{0,20}\bmetro)\b/i,
            feasible: /\b(feasib\w*|viab\w*|residual (land )?value|what can (i|we|you) build|worth (it )?to (a )?developers?|developer (value|margin|returns?)|(does|would) (building|development|construction) pay|tod far|far (increase|hike|bump))\b/i,
            redevelop: /\b(redevelop\w*|re-?built|rebuild\w*|getting taller|vertical (growth|expansion)|builder floors?|floors? (being )?added|old (neighbou?rhoods?|colon(y|ies)|areas?)\b.{0,25}\b(rebuilt|taller|redeveloped))\b/i,
            nextgrowth: /\b(grow(s|ing)? next|next (growth|expansion)|growth frontiers?|future (growth|development|built[\s-]?up|expansion)|where (will|would|is) (the )?city (grow|expand)\w*|(2030|projected) (built[\s-]?up|growth|urbani[sz]ation|expansion))\b/i,
            undervalued: /\b(under[\s-]?valued|under[\s-]?priced|(good|best|smart) (place|area|locality|localit(y|ies)|neighbou?rhoods?) to (invest|buy)|where (to|should i|should we|can i) (invest|buy (land|property|a (flat|plot|house)))|investment (picks?|hotspots?|opportunit\w*)|(appreciat\w*|capital growth) (potential|hotspots?))\b/i,
            rentdemand: /\b(rent(al)? (demand|yields?|hotspots?|market)|(high|best|good) rental|renters?|tenants?|paying guest|pg accommodation|where .{0,20}\brent\b)\b/i,
            affordability: /\b(afford\w*|unaffordab\w*|displace\w*|gentrif\w*|price[\s-]?(to[\s-]?)?income|priced out|evict\w*)\b/i,
            vacant: /\b(vacant|empty|unused|undeveloped|open) (land|plots?|parcels?|lots?)\b|\bland ?bank\b/i,
            buildhot: /\b(construction (hotspots?|activity|boom|pipeline)|building boom|new (construction|buildings|floor (area|space))|where .{0,25}\b(being built|building (fastest|most)|construct\w*))\b/i,
            landvalue: /\b(land (values?|prices?|rates?)|circle rates?|property (prices?|values?|rates?)|real[\s-]?estate (prices?|values?)|(dearest|costliest|most expensive|cheapest|priciest) (land|neighbou?rhoods?|areas?|localit(y|ies)|colon(y|ies))|price per (sq|square))/i,
            heat: /\b(heat[\s-]?(vulnerab\w*|risk|wave|stress|exposure)|hottest neighbourhoods?|who (suffers|is most at risk) .{0,20}heat)\b/i,
            flood: /\b(flood\s?plain|flood (exposure|exposed)|(how many|people|residents|population|who)\b.{0,30}\b(flood(ed|s|ing)?|floodplain)\b.{0,20}\b(live|exposed|risk|zone|area))/i,
            fifteen: /\b(15|fifteen)[\s-]?min(ute)?s?\b|\bwalk(ing|able)? (to|distance (to|of)) (daily|essentials?|shops|amenities)|\bdaily needs\b|\bland[\s-]?use mix\b/i,
            waterlog: /\b(water[\s-]?log\w*|rain(water)? (pools?|pooling|collects?|stagnat\w*)|pluvial|urban flood\w*|stagnant water|where (does )?(the )?rain(water)? (collect|pool|stand)s?)\b/i,
            schoolrun: /\b(school (run|streets?|drop[\s-]?offs?|pick[\s-]?ups?|traffic|gates?|zones? traffic)|drop[\s-]?off traffic|(traffic|jams?|congestion)\b.{0,25}\bschools?|schools?\b.{0,30}\b(traffic|jams?|congestion))\b/i,
            tod: /\b(tod|transit[\s-]?oriented( development)?|densif\w*|floor area ratio|far|fsi)\b.{0,40}\b(stations?|metro|transit|corridors?)\b|\b(stations?|metro)\b.{0,30}\b(densit\w*|densif\w*|redevelop\w*|tod|floor area ratio|fsi)\b/i,
            jamcost: /\b(cost|price|losses?|lost|waste[sd]?|rupees?|crores?|economic (cost|loss))\b.{0,30}\b(congestion|traffic|jams?)\b|\b(congestion|traffic|jams?)\b.{0,30}\b(cost\w*|losses?|lost hours|hours lost|waste\w*|rupees?|crores?)\b/i,
            commute: /\b(commut\w*|trip (length|distance)s?|how far (do )?people (travel|commute))\b.{0,40}\b(carbon|co2|emissions?|footprint|distance|long\w*|km|far)\b|\b(transport|travel|commut\w*) (carbon|co2|emissions?|footprint)\b/i,
            feeder: /\b(last[\s-]?mile|first[\s-]?mile|feeder (bus\w*|routes?|services?))\b/i,
            busheat: /\b(add|more|new|build|need\w*|install) (bus )?shelters?\b|\b(bus (stops?|shelters?)|bus[\s-]?stop shelters?|waiting (for (the|a) bus|in the sun))\b.{0,40}\b(heat|hot|sun|shade|shad(ed|y)|shelters?|trees?)\b|\b(heat|hot|sun|shade|shelters?)\b.{0,30}\bbus (stops?|shelters?)\b/i,
            summershade: /\b(summer shade|shade in (the )?summer|trees? (lose|losing|drop|dropping|shed|shedding) (their )?leaves|deciduous|evergreen (trees?|shade)|leafless trees?|tree (species )?diversity)\b/i,
            jobaccess: /\b(jobs?|work(places?)?|employment|offices?)\b.{0,40}\b(reach\w*|within \d+ ?min\w*|access\w*|commut\w*|by (car|train|metro|public transport|transit))\b|\b(job|employment) access\w*\b|\b(reach|get to)\b.{0,20}\b(jobs?|work)\b/i,
            cleanwalk: /\b(exhaust|fumes|pollut\w*|air quality|breath\w*)\b.{0,40}\b(walk\w*|routes?|commut\w*|school run|way to school|cycl\w*)\b|\b(walk\w*|routes?|commut\w*)\b.{0,40}\b(exhaust|fumes|pollut\w*)\b|\bclean(er)? (air )?routes?\b/i,
            freight: /\b(trucks?|lorr(y|ies)|freight|logistics|goods vehicles?|hgvs?|warehous\w*|godowns?|delivery vans?)\b/i,
            crossing: /\b(zebra|pedestrian) crossings?\b|\b(foot ?over ?bridges?|fobs?|subways? for pedestrians|jaywalk\w*)\b|\bcross(ing)? the (main |busy )?road\b|\bcrossing gaps?\b|\b(no|without|lack of|missing) (safe )?crossings?\b/i,
            nightwalk: /\bstreet ?lights?\b|\b(dark|unlit|poorly lit|street ?lights?|lighting|lit|at night|after dark|night[\s-]?time)\b.{0,40}\b(walk\w*|routes?|stations?|streets?|stretch\w*|safe\w*|women)\b|\b(walk\w*|routes?|women|safe\w*)\b.{0,40}\b(at night|after dark|dark|unlit|street ?lights?)\b/i,
            cycling: /\b(cycl(e|ing|ists?)|bicycles?|bikes?|bike lanes?|cycle (tracks?|lanes?|paths?))\b.{0,40}\b(safe\w*|network|lanes?|tracks?|school|stations?|routes?|islands?|gaps?|infrastructure|can|could|where)\b|\b(safe|low[\s-]?stress)\b.{0,20}\b(cycl\w*|bik\w*)\b/i,
            roadsafety: /\b(road safety|pedestrian (safety|deaths?|fatalit\w*|risk|crossings?)|safe (routes?|walk\w*|crossings?) to schools?|school (zones?|crossings?|walks?)|dangerous (roads?|crossings?|junctions?)|speeding)\b|\b(children|kids|students|pupils)\b.{0,40}\b(cross\w*|walk\w*)\b.{0,30}\b(roads?|traffic|highways?|arterials?)\b/i,
            ambulance: /\b(ambulances?|emergency (response|access|vehicles?)|golden hour)\b|\b(hospitals?|emergency rooms?|a&e|casualty)\b.{0,40}\b(rush hour|peak hours?|in traffic|at \d{1,2}\s?(am|pm)|morning|evening|drive time|by road|minutes? away)\b|\b(rush hour|peak hours?|in traffic)\b.{0,40}\bhospitals?\b|\bschools?\b.{0,30}\b(noisy|jammed|busy|congested) roads?\b/i,
            ev: /\b(ev|electric vehicles?|e-?vehicles?)\b.{0,30}\bcharg\w*\b.{0,40}\b(gaps?|coverage|how many|how far|far|near\w*|access\w*|enough|deserts?)\b|\b(gaps?|coverage|how many|enough)\b.{0,30}\b(ev|electric vehicle) charg\w*|\bcharg(ing|er) (gaps?|coverage|deserts?)\b/i,
            parking: /\b(parking|parked (cars?|vehicles?|bikes?)|double[\s-]?park\w*|footpath parking|park[\s-]?and[\s-]?ride)\b/i,
            shade: /\b(shad(e|ed|y)|tree cover|canopy)\b.{0,40}\b(walk\w*|routes?|streets?|footpaths?|schools?|stations?)\b|\b(walk\w*|routes?)\b.{0,40}\b(shad(e|ed|y)|trees?|canopy)\b|\bcool (walking )?routes?\b|\bwhere (to|should we) plant\b/i,
            busgap: /\b(bus (gaps?|routes? (missing|needed|gaps?))|(new|more|missing|frequent) bus (routes?|service)|(roads?|corridors?)\b.{0,30}\b(no|without|lack\w*) (a |frequent )?bus(es)?)\b|\bwhere (do we|should we|to) (add|run) (more )?bus(es)?\b/i,
            noise: /\b(noise|nois(y|ier|iest)|loud|decibels?|honking|road noise|sound pollution)\b/i,
            traffic: /\b(traffic (load|jams?|congestion|volume|flow|movement)|congest\w*|jams?|peak[\s-]?hour|rush hour|level of service|busiest roads?|bottlenecks?|evening (traffic|peak)|traffic (at|by|through the) (night|day|hour|time)|time of day traffic)\b/i,
            cutoff: /\b(cut off|stranded|isolated|lose access|cannot reach)\b.{0,40}\bfloods?\b|\bfloods?\b.{0,40}\b(cut off|stranded|isolat\w*|lose access|access to (hospitals?|health\s?care|clinics?))\b/i,
            metro: /\b(metro|subway|mrts|local trains?|suburban rail|rail(way)? stations?|train stations?)\b.{0,40}\b(catchments?|walk\w*|within|near\w*|far|access\w*|reach|coverage|gaps?)\b|\b(walk\w*|within|near\w*|far from|catchments? of)\b.{0,30}\b(metro|subway|mrts|rail(way)? stations?|train stations?)\b|\bstation catchments?\b|\bmetro (access|coverage|catchments?)\b/i,
            fair: /\b(environmental (justice|injustice)|poor(er|est)? (neighbourhoods?|neighborhoods?|areas?|residents?|people)\b.{0,40}\b(burden|worse|exposed|more|less|access)|fair(ness)? by wealth|rich (vs|versus|and) poor|wealth (gap|divide))\b/i,
            transit: /\b(public transport|transit|bus stops?|metro|stations?)\b.{0,20}\b(access|accessibility|coverage|reach|walk\w*|near\w*|far)\b|\b(access|walk\w*|near\w*|far) to (a |the )?(public transport|transit|bus stops?|metro|stations?)\b|\bsdg 11\.2\b/i,
            health: /\b(health\s?care|hospitals?|clinics?|doctors?)\b.{0,15}\b(access|accessibility|deserts?|scarc\w*|shortages?|reach)\b|\baccess to (health\s?care|hospitals?|clinics?|doctors?)\b|\bcare deserts?\b|\b2sfca\b/i,
            air: /\b(pm\s?2\.?5|air[\s-]?pollution exposure|breathe|dirty air|(people|residents|who)\b.{0,25}\b(polluted|pollution)\b)/i,
            lights: /\b(night[\s-]?lights?|luminosity|economic activity)\b/i,
            walk: /\b(walkability index|how walkable|walkable (streets?|city|fabric)|intersection density|street connectivity)\b/i,
            sprawl: /\b(sprawl\w*|compact(ness)?|infill|leapfrog\w*|density gradient|urban (expansion|growth pattern))\b/i,
            types: /\b(archetypes?|typolog\w*|kinds? of (places?|neighbou?rhoods?)|types? of neighbou?rhoods?|neighbou?rhood types?|cluster(s|ing)? of neighbou?rhoods?)\b/i,
            green: /\b(3[\s-]?30[\s-]?300|tree canopy (rule|target|cover)|green space within|enough (trees|green))\b/i,
            solar: /\b(roof\s?top solar|solar (potential|roofs?|power|capacity)|how much solar)\b/i,
            confidence: /\b(data (confidence|quality|completeness)|how (reliable|accurate|complete) is (the|this) data|osm completeness|can i trust)\b/i,
            seasons: /\b(season(al|s)?|which months?|worst months?|months? (of|with) (heat|pollution|smog)|getting (hotter|warmer)|warming)\b/i,
            burden: /\b(compound (risk|hazard)s?|multi[\s-]?hazard|triple burden|most at risk overall)\b/i,
            all: /\b(equity|inequal\w*|unequal|unfair|gini|fairness|left behind|urban lens(es)?|lenses)\b/i,
        },
        tour: /\b(tour|fly (me )?(through|over|around)|show me around|walk me through (the |this )?city|city overview|overview of (the |this )?city)\b/i,
        where: /\bwhere\b.{0,40}\b(hotter|warmer|cooler|colder|greener|less green|browner|drier|wetter|rainier|more polluted|cleaner|dirtier|chang(ed|e) (the )?most|moved most)\b/i,
        changes: /\b(what('?s| has| have)? changed|what changed|latest (month|data|changes?)|this month|recent(ly)? chang\w*|what'?s new)\b/i,
    };

    function _cities() {
        if (typeof UrbanInsights === 'undefined' || typeof CellStore === 'undefined') return [];
        return UrbanInsights.cities(CellStore);
    }

    /** Cities named in a question, in order of mention. */
    function citiesIn(question, cities) {
        const q = String(question || '').toLowerCase();
        const hits = [];
        for (const c of cities || []) {
            const names = [c.label.toLowerCase(), c.name.replace(/_pilot$/, '').replace(/_/g, ' ')];
            if (c.name === 'delhi') names.push('new delhi');
            if (c.name === 'bengaluru') names.push('bangalore');
            if (c.name === 'mumbai') names.push('bombay');
            const at = Math.min(...names.map(n => { const m = new RegExp(`\\b${n}\\b`).exec(q); return m ? m.index : Infinity; }));
            if (at < Infinity) hits.push({ city: c.name, at });
        }
        return hits.sort((a, b) => a.at - b.at).map(h => h.city);
    }

    // Named-road what-ifs: "what if MG Road closes at 6 pm", "widen AB Road".
    const ROAD_WORD = '(?:ring road|road|rd|marg|street|highway|flyover|bridge|expressway|bypass|avenue|setu|path)';
    const ROAD_VERB_FIRST = new RegExp(`\\b(close|closing|shut(?:ting)?|block(?:ing)?|widen(?:ing)?)\\s+(?:down\\s+)?([a-z0-9][\\w.'\\- ]{0,40}?\\b${ROAD_WORD})\\b`, 'i');
    const ROAD_NAME_FIRST = new RegExp(`([a-z0-9][\\w.'\\- ]{0,40}?\\b${ROAD_WORD})\\s+(?:is |was |were |gets? |got |to be )?(closed|closes|closing|shut|blocked|widened)\\b`, 'i');
    const LEAD = /^(?:(?:what|if|happens|happen|when|would|will|suppose|imagine|we|i|they|the|a|an|and|then|say)\s+)+/i;
    const GENERIC = /^(?:a|an|the|this|that|any|one|main|my|our|some|every|each|nearby|local|busy|busiest)?\s*$/i;

    /** {action, road, period} for a named-road closure/widening question, or null. Pure. */
    function roadAsk(question) {
        const q = String(question || '');
        let action = null, road = null;
        let m = ROAD_VERB_FIRST.exec(q);
        if (m) { action = /widen/i.test(m[1]) ? 'widen' : 'close'; road = m[2]; }
        else if ((m = ROAD_NAME_FIRST.exec(q))) { action = /widen/i.test(m[2]) ? 'widen' : 'close'; road = m[1]; }
        if (!road) return null;
        road = road.replace(LEAD, '').trim();
        const core = road.replace(new RegExp(`\\s*\\b${ROAD_WORD}$`, 'i'), '');
        if (GENERIC.test(core) || core.length < 2) return null;
        const period = /\b(evening|6\s?pm|18:00|19:00|7\s?pm|going home|return trip)\b/i.test(q) ? 'pm' : 'am';
        return { action, road, period };
    }

    /** Route a question to the insights engine, or null. Pure given `cities`. */
    function match(question, cities) {
        const q = String(question || '');
        if (!q.trim()) return null;
        const named = citiesIn(q, cities);
        const sat = /\b(next|when|due|upcoming)\b.{0,40}\b(satellites?|sentinel[\s-]?[123]?|landsat|resourcesat|cartosat|imagery|overpass(es)?)\b|\bsatellite (pass(es)?|overpass(es)?)\b|\boverpass(es)?\b|\b(satellites?|sentinel[\s-]?[123]?|landsat)\b.{0,30}\b(next|pass(es)?|due|overhead)\b/i;
        if (sat.test(q)) {
            const only = /\b(radar|sar|sentinel[\s-]?1)\b/i.test(q) ? 'radar' : /\bsentinel[\s-]?2\b/i.test(q) ? 'sentinel2' : /\blandsat\b/i.test(q) ? 'landsat' : null;
            return only ? { type: 'satpasses', only } : { type: 'satpasses' };
        }
        if (/\bwhat(?:'?s| is)\s+(happening|going on)\b(?!.{0,30}\b(19|20)\d\d\b)|\b(right now|live (conditions?|situation|update|feeds?)|current (conditions?|situation)|situation (here|now|today))\b|\bany (alerts?|warnings?)\b.{0,20}\b(here|now|today)\b/i.test(q)) {
            return { type: 'livenow' };
        }
        const mob = /\b(mobility|transport|transit|commut\w*|traffic)\b.{0,30}\b(scorecard|score|rank\w*|league|across (the |all )?cities|which city)\b|\b(scorecard|rank\w*|league|which city|best city|worst city|compare (all )?cities)\b.{0,40}\b(mobility|transport|transit|commut\w*|traffic|getting around)\b|\bmobility scorecard\b/i;
        if (mob.test(q) && named.length < 2) return named.length ? { type: 'mobilityscore', city: named[0] } : { type: 'mobilityscore' };
        const re = /\b(real[\s-]?estate|property|housing|land)\b.{0,30}\b(scorecard|rank\w*|league|across (the |all )?cities|which city)\b|\b(scorecard|rank\w*|league|which city|best city|worst city|compare (all )?cities)\b.{0,40}\b(real[\s-]?estate|property|housing|invest\w*)\b|\breal[\s-]?estate scorecard\b/i;
        if (re.test(q) && named.length < 2) return named.length ? { type: 'mobilityscore', board: 'realestate', city: named[0] } : { type: 'mobilityscore', board: 'realestate' };
        if (RE.dashboard.test(q)) return { type: 'dashboard' };
        if (RE.where.test(q)) {
            const w = RE.where.exec(q)[1].toLowerCase();
            const topic = /hott|warm|cool|cold/.test(w) ? 'heat' : /green|brown/.test(w) ? 'green' : /dri|wet|rain/.test(w) ? 'rain' : /pollut|clean|dirt/.test(w) ? 'air' : null;
            const out = { type: 'where', topic, dir: /cool|cold|less green|brown|dri|clean/.test(w) ? 'down' : /hott|warm|green|wet|rain|pollut|dirt/.test(w) ? 'up' : null };
            if (named.length) out.city = named[0];
            return out;
        }
        if (RE.tour.test(q)) {
            const out = { type: 'tour', play: /\b(tour|fly|show me around|walk me)\b/i.test(q) };
            if (named.length) out.city = named[0];
            return out;
        }
        if (RE.changes.test(q)) return named.length ? { type: 'changes', city: named[0] } : { type: 'changes' };
        if (RE.compare.test(q) && named.length >= 2) return { type: 'compare', a: { city: named[0] }, b: { city: named[1] } };
        const bus = /\b(?:bus[\s-]?(?:only[\s-]?)?lanes?|bus priority(?: lanes?)?|brts(?: corridor)?|dedicated bus (?:lanes?|corridors?))\s+(?:on|along|down|for)\s+(?:the\s+)?(.+?)(?=\s+(?:in|at|during|with|and|if|would|will)\b|[?.,!]|$)/i.exec(q)
            || /\b(?:add|put|give|build|what if)\b.{0,20}?\b(?:the\s+)?([a-z0-9][\w.' -]{2,40}?)\s+(?:a\s+)?(?:bus[\s-]?lanes?|brts)\b/i.exec(q);
        if (bus && bus[1]) {
            const m = /(\d{1,3})\s*(%|percent|per cent)/i.exec(q);
            const out = { type: 'buslane', road: bus[1].replace(/^(the|a)\s+/i, '').trim(), pct: m ? Math.max(0, Math.min(100, Number(m[1]))) : 10,
                period: /\b(evening|6\s?pm|18:00|going home)\b/i.test(q) ? 'pm' : 'am' };
            if (named.length) out.city = named[0];
            return out;
        }
        const shift = /\bmode[\s-]?shift\b|\b(shift|switch|move|moved|moving|leave|leaves|take|took|use|used)\b.{0,40}\b(metro|trains?|rail|public transport|transit|bus(es)?)\b|\b(metro|trains?|public transport|transit|bus(es)?)\b.{0,30}\binstead of (driving|cars?)\b/i;
        if (shift.test(q) && /\b(cars?|driv\w*|vehicles?|trips?|commut\w*|traffic|people|drivers)\b/i.test(q)) {
            const m = /(\d{1,3})\s*(%|percent|per cent)/i.exec(q);
            const out = { type: 'modeshift', pct: m ? Math.max(1, Math.min(100, Number(m[1]))) : 10,
                scope: /\b(metro|trains?|rail)\b/i.test(q) ? 'stations' : 'all',
                period: /\b(evening|6\s?pm|18:00|going home)\b/i.test(q) ? 'pm' : 'am' };
            if (named.length) out.city = named[0];
            return out;
        }
        const wet = /\b(monsoon|heavy rain|rains?|rainy|downpour|cloudburst|waterlog\w*|flood\w*)\b.{0,50}\b(traffic|roads?|commute|jams?|congestion)\b|\b(traffic|roads?|commute|congestion)\b.{0,50}\b(monsoon|heavy rain|rains?|rainy|downpour|cloudburst|waterlog\w*|flood\w*)\b/i;
        if (wet.test(q) && !/\b(people|residents|who|households?)\b/i.test(q)) {
            const level = /\b(river|yamuna|ganga|mithi|extreme|100[\s-]?year|cloudburst)\b/i.test(q) ? 'extreme'
                : /\b(shower|drizzle|light|moderate)\b/i.test(q) ? 'heavy' : 'severe';
            const out = { type: 'monsoonroads', level, period: /\b(evening|6\s?pm|18:00|18h|going home)\b/i.test(q) ? 'pm' : 'am' };
            if (named.length) out.city = named[0];
            return out;
        }
        const station = /\b(new|next|another|extra|add(ing)?|open(s|ed|ing)?|build(ing)?)\b.{0,25}\b(metro|rail|train) stations?\b|\b(metro|rail|train) stations?\b.{0,25}\b(open(s|ed)?|built|added) (here|at|in|near)\b/i;
        if (station.test(q)) {
            const out = { type: 'stationwhatif', here: /\b(here|this (cell|spot|place|location|area|site)|selected (cell|spot))\b/i.test(q) };
            if (named.length) out.city = named[0];
            return out;
        }
        const farq = /(?<!\b(?:how|so|too|as|not|by)\s)\b(?:far|floor area ratio|fsi)\s*(?:(?:is|were|was|went to|goes to|becomes|of|=|to|at|raised to|increased to)\s*)?(\d+(?:\.\d+)?)\b|\b(?:at|with) (?:an? )?(?:far|fsi) (?:of )?(\d+(?:\.\d+)?)\b/i.exec(q);
        if (farq && /\b(what if|if|could|would|at|with|here|this|build)\b/i.test(q)) {
            const v = Number(farq[1] || farq[2]);
            if (v > 0 && v <= 20) return { type: 'farwhatif', far: v };
        }
        if (/\b(which|what|whose|who('s| is)?)\b.{0,40}\b(ward|pin ?code|pincode|postal code|post ?code|constituency|mla|mp|corporator|councillor|councilor|neighbou?rhood|locality|colony|police station|thana)\b|\b(ward|pin ?code|pincode|constituency|mla|corporator|police station|thana)\b.{0,20}\b(here|this (block|spot|place|area))\b/i.test(q) && /\b(this|here|my)\b/i.test(q) && !/\b(most|least|best|worst|top|rank\w*|hottest|which (wards|neighbou?rhoods|localities|colonies))\b/i.test(q)) return { type: 'whereis' };
        if (/\b(property|real[\s-]?estate|investment|land) (report|brief|memo|check|due[\s-]?diligence)\b|\bdue[\s-]?diligence\b/i.test(q)) return { type: 'propreport' };
        const lookq = /\b(look(s|ing)? (the same|alike|like (this|here))|look-?alikes?|(physically|visually) (similar|alike)|same (built form|urban form|texture|look)|from (space|above|the sky|satellite)|satellite (twins?|look-?alikes?|similar\w*))\b/i;
        if (lookq.test(q) && /\b(like|similar|same|alike|twins?|look)\w*\b/i.test(q)) {
            const out = { type: 'lookalike' };
            if (named.length) out.city = named[named.length - 1];
            return out;
        }
        const like = /\b(places?|areas?|localit(y|ies)|neighbou?rhoods?|blocks?|colon(y|ies)|spots?)\s+(like|similar to)\s+(this|here|the selected)\b|\b(similar|comparable) (places?|areas?|localit(y|ies)|neighbou?rhoods?|blocks?)\b|\bcomparables?\b|\bwhere else (is|are) (like|similar)\b/i;
        if (like.test(q)) {
            const out = { type: 'similar' };
            if (/\b(every|each|all|other) (the )?(other )?cit(y|ies)\b|\bacross (all )?(the )?cities\b|\bcity by city\b/i.test(q)) out.all = true;
            else if (named.length) out.city = named[named.length - 1];
            return out;
        }
        const siting = /\bwhere (should|to|could|would|can)\b.{0,40}\b(clinics?|hospitals?|health (centre|center)s?|schools?|parks?|cool roofs?|ev|charg\w*)\b|\b(best|ideal|suitable) (locations?|sites?|places?) for\b|\bsite (selection|suitability)\b|\bsiting\b/i;
        if (siting.test(q)) {
            const preset = /\bschool/i.test(q) ? 'school' : /\bpark|garden|green/i.test(q) ? 'park' : /\bcool roof/i.test(q) ? 'cool_roofs'
                : /\bev\b|charg/i.test(q) ? 'ev_charging' : 'clinic';
            const out = { type: 'lens', lens: 'siting', preset };
            if (named.length) out.city = named[0];
            return out;
        }
        if (/\bwhat[\s-]?if\b|\bimagine\b|\bsimulate\b|\bscenario\b|\bif (we|they|i)\b|\bwiden/i.test(q) || RE.park.test(q) || RE.flood.test(q) || RE.cool.test(q) || RE.closure.test(q)) {
            const ra = roadAsk(q);
            if (ra) return named.length ? { type: 'roadwhatif', ...ra, city: named[0] } : { type: 'roadwhatif', ...ra };
            if (RE.closure.test(q)) return { type: 'whatif', scenario: 'closure' };
            const fac = /\b(new|add(ed|ing)?|build|open(ed|ing)?|put)\b.{0,25}\b(metro (station|stop)|clinic|health (centre|center)|school)s?\b/i.exec(q);
            if (fac) return { type: 'whatif', scenario: /metro/i.test(fac[0]) ? 'metro' : /school/i.test(fac[0]) ? 'school' : 'clinic' };
            if (RE.cool.test(q)) {
                const m = /(\d{1,2})\s*(%|percent|pts|points)/i.exec(q);
                return { type: 'whatif', scenario: 'cool', trees: m ? Number(m[1]) : 20 };
            }
            if (RE.park.test(q)) return { type: 'whatif', scenario: 'park' };
            if (RE.flood.test(q) || /\bflood/i.test(q)) {
                const level = /\bextreme|worst|cloudburst\b/i.test(q) ? 'extreme' : /\bmoderate|minor|light\b/i.test(q) ? 'moderate' : 'severe';
                return { type: 'whatif', scenario: 'flood', level };
            }
            if (RE.density.test(q)) {
                const m = /(\d+(?:\.\d+)?)\s*(x|×|times)/i.exec(q);
                const factor = m ? Number(m[1]) : /\btriple\b/i.test(q) ? 3 : /\bdouble\b/i.test(q) ? 2 : 1.5;
                return { type: 'whatif', scenario: 'density', factor };
            }
        }
        if (RE.density.test(q) && /\bwhat|happen|impact|effect\b/i.test(q)) {
            const m = /(\d+(?:\.\d+)?)\s*(x|×|times)/i.exec(q);
            return { type: 'whatif', scenario: 'density', factor: m ? Number(m[1]) : /\btriple\b/i.test(q) ? 3 : /\bdouble\b/i.test(q) ? 2 : 1.5 };
        }
        for (const [id, re] of Object.entries(RE.lens)) {
            if (!re.test(q)) continue;
            const out = { type: 'lens', lens: id === 'all' ? null : id };
            if (named.length) out.city = named[0];
            return out;
        }
        if (RE.insights.test(q)) return { type: 'insights' };
        return null;
    }

    /** Plain-text answer for a metro station what-if. Pure. */
    function stationText(r) {
        const s = r.s, lines = [];
        if (s.at) {
            lines.push(s.at.people > 0
                ? `A metro station at ${s.at.code} would bring ${Math.round(s.at.people).toLocaleString('en-IN')} more residents within a ${s.at.walkMin}-minute walk (${s.at.alreadyServed.toLocaleString('en-IN')} nearby are already served${s.at.nearestMin != null ? `; the metro is ${s.at.nearestMin} min away on foot today` : ''}).`
                : `Everyone within a ${s.at.walkMin}-minute walk of ${s.at.code} is already that close to a metro station.`);
        } else if (s.sites.length) {
            lines.push(`The best new metro station sites in ${r.cityLabel}, each adding the most residents not already within a 10-minute walk:`);
        } else {
            lines.push(`No metro stations are mapped in ${r.cityLabel}, or everyone is already within a 10-minute walk.`);
        }
        if (s.sites.length) s.sites.forEach(x => lines.push(`${x.rank}. ${x.code}: +${x.people.toLocaleString('en-IN')} residents (now ${x.nearestMin} min walk from the metro)`));
        return lines.join('\n');
    }

    /** The distinct [C#] tags in a reply, in order. Pure. */
    function citeTags(text) {
        const out = [];
        const re = /\[(C\d{1,2})\]/g;
        let m;
        while ((m = re.exec(String(text || '')))) if (!out.includes(m[1])) out.push(m[1]);
        return out;
    }

    /** "Which ward / PIN / constituency is this?" for a block, from UrbanLenses.places. */
    function whereText(r) {
        const w = r.w;
        if (!w) return `${DigiPin.format(r.code)} in ${r.cityLabel} has no neighbourhood, ward or constituency on file (it may be outside the lived-in blocks).`;
        const lines = [];
        if (w.label) lines.push(`Neighbourhood: ${w.label}${w.district && !w.label.includes(w.district) ? ` (${w.district} district)` : ''}`);
        if (w.pin) lines.push(`PIN code: ${w.pin} (the code most addresses around it carry)`);
        if (w.ward) lines.push(`Municipal ward: ${w.ward}${w.body ? `, ${w.body}` : ''} (ward map may predate the latest delimitation)`);
        if (w.assembly) lines.push(`Assembly constituency: ${w.assembly}${w.lokSabha ? `; Lok Sabha: ${w.lokSabha}` : ''}`);
        if (w.mp) lines.push(`Member of Parliament (elected 2024): ${w.mp}${w.mpParty ? `, ${w.mpParty}` : ''}`);
        if (w.police) lines.push(`Police station: ${w.police} (law and order jurisdiction)`);
        return lines.join('\n');
    }

    function _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function _bbox() {
        const map = (typeof MapModule !== 'undefined' && MapModule.getMap) ? MapModule.getMap() : null;
        if (!map || !map.getBounds) return null;
        const b = map.getBounds();
        return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
    }

    function _openButton(label, tab) {
        const b = _el('button', 'disha-scan-export', label);
        b.type = 'button';
        b.addEventListener('click', () => { if (typeof InsightsPanel !== 'undefined') InsightsPanel.open(tab); });
        return b;
    }

    function _viewCenter() {
        const m = typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null;
        if (!m || !m.getCenter) return null;
        const c = m.getCenter();
        return { lat: c.lat, lng: c.lng };
    }

    /**
     * Answer an intent from the engine into chat element `el`. ctx = { cell }.
     * Returns the plain-text result (for the model to narrate) or '' on failure.
     */
    async function answer(el, intent, ctx = {}) {
        el.textContent = '';
        if (intent.type === 'satpasses') return _satAnswer(el, intent, ctx.cell);
        if (intent.type === 'livenow') return _liveAnswer(el, ctx.cell);
        if (typeof UrbanInsights === 'undefined' || typeof CellStore === 'undefined' || !CellStore.isEnabled()) {
            el.textContent = 'The per-cell data store is not loaded, so I cannot compute this yet.';
            return '';
        }
        const cell = ctx.cell;
        const center = cell && cell.center;
        let r;
        try {
            if (intent.type === 'insights') {
                const code = cell ? cell.code.replace(/-/g, '').slice(0, 5) : null;
                r = await UrbanInsights.areaInsights(code ? { code, label: `The area around ${DigiPin.format(code)}` } : { bbox: _bbox(), label: 'The map view' }, CellStore, { limit: 6 });
            } else if (intent.type === 'changes') {
                let city = intent.city;
                if (!city) {
                    const p = center || _viewCenter();
                    city = p ? UrbanInsights.cityAt(CellStore, p.lat, p.lng) : null;
                }
                if (!city) { el.textContent = 'Pan the map to a city (or name one) and ask again.'; return ''; }
                r = await UrbanInsights.changes(CellStore, { city, limit: 6 });
            } else if (intent.type === 'where') {
                let city = intent.city;
                if (!city) {
                    const p = center || _viewCenter();
                    city = p ? UrbanInsights.cityAt(CellStore, p.lat, p.lng) : null;
                }
                if (!city) { el.textContent = 'Pan the map to a city (or name one) and ask again.'; return ''; }
                r = await whereChanged(CellStore, { city, topic: intent.topic, dir: intent.dir });
                if (!r) { el.textContent = 'No series here has a year-earlier step to compare with.'; return ''; }
            } else if (intent.type === 'tour') {
                let city = intent.city;
                if (!city) {
                    const p = center || _viewCenter();
                    city = p ? UrbanInsights.cityAt(CellStore, p.lat, p.lng) : null;
                }
                if (!city) { el.textContent = 'Pan the map to a city (or name one) and ask again.'; return ''; }
                if (typeof CityTour === 'undefined') { el.textContent = 'The tour module did not load.'; return ''; }
                const stops = await CityTour.buildStops(city, CellStore);
                if (!stops.length) { el.textContent = 'Not enough data in this city for a tour.'; return ''; }
                r = { kind: 'tour', city, cityLabel: UrbanInsights.cityLabel(city), stops, play: !!intent.play };
            } else if (intent.type === 'lens') {
                let city = intent.city;
                if (!city) {
                    const p = center || _viewCenter();
                    city = p ? UrbanInsights.cityAt(CellStore, p.lat, p.lng) : null;
                }
                if (!city) { el.textContent = 'Pan the map to a city (or name one) and ask again.'; return ''; }
                if (typeof UrbanLenses === 'undefined') { el.textContent = 'The lenses module did not load.'; return ''; }
                const run = typeof LensesPanel !== 'undefined' ? LensesPanel.result(city, CellStore) : UrbanLenses.run(city, CellStore);
                const res = await run;
                if (intent.lens === 'siting') {
                    const st = UrbanLenses.site(res, intent.preset || 'clinic');
                    if (!st) { el.textContent = 'Not enough data in this city to site that.'; return ''; }
                    r = { kind: 'siting', cityLabel: res.cityLabel, st, sources: res.sources.filter(x => st.sources.includes(x.id)) };
                } else r = { ...res, only: intent.lens ? [intent.lens] : null };
            } else if (intent.type === 'mobilityscore') {
                if (typeof UrbanLenses === 'undefined' || !UrbanLenses.scorecard) { el.textContent = 'The lenses module did not load.'; return ''; }
                const league = await fetch('data/lenses/league.json').then(x => (x.ok ? x.json() : null)).catch(() => null);
                const sc = intent.board === 'realestate' ? (UrbanLenses.reScorecard ? UrbanLenses.reScorecard(league) : null) : UrbanLenses.scorecard(league);
                if (!sc) { el.textContent = `The cross-city ${intent.board === 'realestate' ? 'real-estate' : 'mobility'} scorecard is not available.`; return ''; }
                r = { kind: 'mobilityscore', sc, city: intent.city || null };
            } else if (intent.type === 'dashboard') {
                r = await UrbanInsights.cityDashboard(CellStore);
            } else if (intent.type === 'compare') {
                r = await UrbanInsights.compare(intent.a, intent.b, CellStore);
            } else if (intent.type === 'whereis') {
                if (!center) { el.textContent = 'Click a block on the map first, then ask which ward, PIN code or constituency it is in.'; return ''; }
                const city = UrbanInsights.cityAt(CellStore, center.lat, center.lng);
                if (!city) { el.textContent = 'That spot is outside the cities I have data for.'; return ''; }
                const code = DigiPin.encode(center.lat, center.lng).replace(/-/g, '').slice(0, 7);
                const w = UrbanLenses.places ? (await UrbanLenses.places(city, CellStore)).get(code) || null : null;
                r = { kind: 'whereis', code, cityLabel: UrbanInsights.cityLabel(city), w };
            } else if (intent.type === 'propreport') {
                if (!center) { el.textContent = 'Click a block on the map first, then ask for its property report.'; return ''; }
                const city = UrbanInsights.cityAt(CellStore, center.lat, center.lng);
                if (!city) { el.textContent = 'That spot is outside the cities I have data for.'; return ''; }
                if (typeof PropertyReport === 'undefined') { el.textContent = 'The property report module did not load.'; return ''; }
                r = { kind: 'propreport', m: await PropertyReport.build(city, center.lat, center.lng, CellStore) };
            } else if (intent.type === 'similar') {
                if (!center) { el.textContent = 'Click a block on the map first, then ask for places like it.'; return ''; }
                const from = UrbanInsights.cityAt(CellStore, center.lat, center.lng);
                if (!from) { el.textContent = 'That spot is outside the cities I have data for.'; return ''; }
                if (typeof UrbanLenses === 'undefined' || !UrbanLenses.similar) { el.textContent = 'The real-estate lenses did not load.'; return ''; }
                if (intent.all && UrbanLenses.similarEverywhere) {
                    el.textContent = 'Searching every city for the closest match…';
                    const s = await UrbanLenses.similarEverywhere({ fromCity: from, lat: center.lat, lng: center.lng, cities: _cities().map(c => c.name) }, CellStore);
                    r = { kind: 'similarall', s };
                } else {
                    const s = await UrbanLenses.similar({ fromCity: from, lat: center.lat, lng: center.lng, toCity: intent.city || from }, CellStore);
                    r = { kind: 'similar', s };
                }
            } else if (intent.type === 'lookalike') {
                if (!center) { el.textContent = 'Click a block on the map first, then ask for places that look like it.'; return ''; }
                const from = UrbanInsights.cityAt(CellStore, center.lat, center.lng);
                if (!from) { el.textContent = 'That spot is outside the cities I have data for.'; return ''; }
                if (typeof UrbanLenses === 'undefined' || !UrbanLenses.lookalike) { el.textContent = 'The real-estate lenses did not load.'; return ''; }
                r = { kind: 'lookalike', s: await UrbanLenses.lookalike({ fromCity: from, lat: center.lat, lng: center.lng, toCity: intent.city || from }, CellStore) };
            } else if (intent.type === 'farwhatif') {
                if (!center) { el.textContent = 'Click a block on the map first, then ask what a higher FAR would do there.'; return ''; }
                const city = UrbanInsights.cityAt(CellStore, center.lat, center.lng);
                if (!city) { el.textContent = 'That spot is outside the cities I have data for.'; return ''; }
                if (typeof UrbanLenses === 'undefined' || !UrbanLenses.farAsk) { el.textContent = 'The real-estate lenses did not load.'; return ''; }
                r = { kind: 'farwhatif', f: await UrbanLenses.farAsk({ city, lat: center.lat, lng: center.lng, far: intent.far }, CellStore), cityLabel: UrbanInsights.cityLabel(city) };
            } else if (intent.type === 'stationwhatif') {
                let city = intent.city;
                if (!city) {
                    const p = center || _viewCenter();
                    city = p ? UrbanInsights.cityAt(CellStore, p.lat, p.lng) : null;
                }
                if (!city) { el.textContent = 'Pan the map to a city (or name one) and ask again.'; return ''; }
                if (typeof UrbanLenses === 'undefined' || !UrbanLenses.stationAsk) { el.textContent = 'The lenses module did not load.'; return ''; }
                if (intent.here && !center) { el.textContent = 'Click a cell on the map first, then ask again: the new station needs a site.'; return ''; }
                const s = await UrbanLenses.stationAsk(city, intent.here ? center.lat : null, intent.here ? center.lng : null, CellStore);
                r = { kind: 'stationwhatif', s, cityLabel: UrbanInsights.cityLabel(city) };
            } else if (intent.type === 'modeshift') {
                if (typeof RoadWhatIf === 'undefined' || !RoadWhatIf.modeShift) { el.textContent = 'The road what-if module did not load.'; return ''; }
                if (intent.city && typeof TrafficOverlay !== 'undefined' && TrafficOverlay.region && TrafficOverlay.region() !== intent.city) {
                    const sel = typeof document !== 'undefined' && document.getElementById('city-select');
                    const opt = sel && [...sel.options].find(o => o.value === intent.city || o.value === intent.city.replace(/_pilot$/, ''));
                    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(res => setTimeout(res, 1500)); }
                }
                if (typeof TrafficOverlay !== 'undefined' && !TrafficOverlay.isVisible()) TrafficOverlay.attach();
                el.textContent = `Re-routing every commute with ${intent.pct}% of car trips on the train or bus…`;
                const a = await RoadWhatIf.modeShift({ pct: intent.pct, scope: intent.scope, period: intent.period });
                el.textContent = '';
                r = { kind: 'roadwhatif', a };
            } else if (intent.type === 'buslane') {
                if (typeof RoadWhatIf === 'undefined' || !RoadWhatIf.busLane) { el.textContent = 'The road what-if module did not load.'; return ''; }
                if (intent.city && typeof TrafficOverlay !== 'undefined' && TrafficOverlay.region && TrafficOverlay.region() !== intent.city) {
                    const sel = typeof document !== 'undefined' && document.getElementById('city-select');
                    const opt = sel && [...sel.options].find(o => o.value === intent.city || o.value === intent.city.replace(/_pilot$/, ''));
                    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(res => setTimeout(res, 1500)); }
                }
                if (typeof TrafficOverlay !== 'undefined' && !TrafficOverlay.isVisible()) TrafficOverlay.attach();
                el.textContent = `Re-routing every commute with a bus lane on ${intent.road}…`;
                const a = await RoadWhatIf.busLane({ road: intent.road, pct: intent.pct, period: intent.period });
                el.textContent = '';
                r = { kind: 'roadwhatif', a };
            } else if (intent.type === 'monsoonroads') {
                if (typeof RoadWhatIf === 'undefined' || !RoadWhatIf.monsoon) { el.textContent = 'The road what-if module did not load.'; return ''; }
                if (intent.city && typeof TrafficOverlay !== 'undefined' && TrafficOverlay.region && TrafficOverlay.region() !== intent.city) {
                    const sel = typeof document !== 'undefined' && document.getElementById('city-select');
                    const opt = sel && [...sel.options].find(o => o.value === intent.city || o.value === intent.city.replace(/_pilot$/, ''));
                    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(res => setTimeout(res, 1500)); }
                }
                if (typeof TrafficOverlay !== 'undefined' && !TrafficOverlay.isVisible()) TrafficOverlay.attach();
                el.textContent = 'Re-routing every commute around the waterlogging-prone roads…';
                const a = await RoadWhatIf.monsoon({ level: intent.level, period: intent.period });
                el.textContent = '';
                r = { kind: 'roadwhatif', a };
            } else if (intent.type === 'roadwhatif') {
                if (typeof RoadWhatIf === 'undefined') { el.textContent = 'The road what-if module did not load.'; return ''; }
                if (intent.city && typeof TrafficOverlay !== 'undefined' && TrafficOverlay.region && TrafficOverlay.region() !== intent.city) {
                    const sel = typeof document !== 'undefined' && document.getElementById('city-select');
                    const opt = sel && [...sel.options].find(o => o.value === intent.city || o.value === intent.city.replace(/_pilot$/, ''));
                    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(res => setTimeout(res, 1500)); }
                }
                el.textContent = `Re-routing every commute with ${intent.road} ${intent.action === 'widen' ? 'widened' : 'closed'}…`;
                const a = await RoadWhatIf.ask({ action: intent.action, road: intent.road, period: intent.period });
                el.textContent = '';
                r = { kind: 'roadwhatif', a };
            } else if (intent.type === 'whatif') {
                const sc = { type: intent.scenario };
                let heights = null;
                if (intent.scenario === 'flood') {
                    sc.level = intent.level;
                    const b = _bbox();
                    if (b) sc.area = { bbox: b, label: 'the map view' };
                    if (center) heights = await UrbanInsights.loadHeights(center.lat, center.lng);
                } else {
                    if (!cell) { el.textContent = 'Click a cell on the map first, then ask again: the scenario needs a site.'; return ''; }
                    sc.code = cell.code.replace(/-/g, '');
                    if (intent.factor) sc.factor = intent.factor;
                    if (intent.trees) sc.trees = intent.trees;
                    if (intent.scenario === 'density' && center) heights = await UrbanInsights.loadHeights(center.lat, center.lng);
                }
                r = await UrbanInsights.whatIf(sc, CellStore, { heights });
            }
        } catch (e) {
            el.textContent = e && e.message ? e.message : 'That could not be computed here.';
            return '';
        }
        if (!r) return '';
        _render(el, r);
        if (r.kind === 'where') {
            if (typeof InsightsPanel !== 'undefined' && InsightsPanel.showChange) InsightsPanel.showChange({ city: r.city, dataset: r.item.dataset, field: r.item.key, step: r.item.step });
            const u = r.item.unit;
            return `${r.item.label} in ${r.cityLabel}, ${r.layer.vs} → ${r.layer.step}: city mean ${UrbanInsights.fmt(r.item.prev, u)} → ${UrbanInsights.fmt(r.item.latest, u)}. `
                + `${r.layer.rose} cells rose, ${r.layer.fell} fell. Largest ${r.dir === 'up' ? 'rises' : 'falls'}: ${r.top.map(t => `${t.digipin} (${t.change > 0 ? '+' : ''}${UrbanInsights.fmt(t.change, u)})`).join(', ')}. The change is now mapped in 3D (red rose, blue fell).`;
        }
        if (r.kind === 'tour') {
            if (r.play) CityTour.play(r.city, CellStore);
            return `Briefing on ${r.cityLabel}${r.play ? ' (the 3D tour is now flying through these stops)' : ''}:\n${r.stops.map((x, i) => `${i + 1}. ${x.label}: ${x.caption}`).join('\n')}`;
        }
        if (r.kind === 'roadwhatif') return RoadWhatIf.askText(r.a);
        if (r.kind === 'whereis') return whereText(r);
        if (r.kind === 'propreport') return PropertyReport.text(r.m);
        if (r.kind === 'similar') return UrbanLenses.similarText(r.s);
        if (r.kind === 'similarall') return UrbanLenses.similarEverywhereText(r.s);
        if (r.kind === 'lookalike') return UrbanLenses.lookalikeText(r.s);
        if (r.kind === 'stationwhatif') return stationText(r);
        if (r.kind === 'farwhatif') return UrbanLenses.farText(r.f);
        if (r.kind === 'mobilityscore') return r.sc.kind === 'realestate' ? UrbanLenses.reScorecardText(r.sc, r.city) : UrbanLenses.scorecardText(r.sc, r.city);
        if (r.kind === 'siting') return `${r.st.title} in ${r.cityLabel}: ${r.st.headline}\n${r.st.sites.map(x => `${x.rank}. ${x.code} (score ${x.score}): ${x.why}`).join('\n')}`;
        return r.kind === 'lenses' ? UrbanLenses.toText(r, r.only) : UrbanInsights.toText(r);
    }

    const TOPIC = { heat: /lst|surface temp|heat/i, green: /ndvi|green|vegetation|tree/i, rain: /rain|precip/i, air: /no2|no₂|pm|aerosol|pollut|air/i };

    /**
     * Where a series moved most across a city: picks the latest change on the
     * topic (or the most unusual one), builds its per-cell change layer and
     * names the cells that moved most in the asked direction.
     */
    async function whereChanged(store, { city, topic, dir }) {
        const ch = await UrbanInsights.changes(store, { city, limit: 40 });
        const pool = topic ? ch.items.filter(x => TOPIC[topic].test(`${x.dataset} ${x.key} ${x.label}`)) : ch.items;
        const x = pool[0] || (topic ? null : ch.items[0]);
        if (!x) return null;
        const L = await UrbanInsights.changeLayer(store, { city, dataset: x.dataset, field: x.key, step: x.step });
        if (!L) return null;
        const d = dir || (x.delta >= 0 ? 'up' : 'down');
        const order = L.table.cells.map((c, i) => i).sort((a, b) => (d === 'up' ? L.table.columns.change[b] - L.table.columns.change[a] : L.table.columns.change[a] - L.table.columns.change[b]));
        const top = order.slice(0, 5).map(i => ({ code: L.table.cells[i], digipin: DigiPin.format(L.table.cells[i]), change: L.table.columns.change[i] }));
        return { kind: 'where', city, cityLabel: UrbanInsights.cityLabel(city), item: x, layer: L, dir: d, top };
    }

    /** Next Earth-observation satellite passes over the selected cell or the view (js/sat-passes.js). */
    async function _satAnswer(el, intent, cell) {
        if (typeof SatPasses === 'undefined' || !SatPasses.passes) { el.textContent = 'The satellite pass module did not load.'; return ''; }
        const at = (cell && cell.center) || _viewCenter();
        if (!at) { el.textContent = 'The map is not ready yet; try again in a moment.'; return ''; }
        const re = { radar: /^Sentinel-1/, sentinel2: /^Sentinel-2/, landsat: /^Landsat/ }[intent.only] || null;
        let rows;
        try { rows = await SatPasses.passes(at.lat, at.lng, re); } catch {
            el.textContent = 'CelesTrak (the orbit source) did not answer; try again in a moment.';
            return '';
        }
        const where = cell && cell.code ? DigiPin.format(cell.code) : 'the map centre';
        el.appendChild(_el('div', 'disha-scan-header', `Next satellite passes · ${where}`));
        const now = Date.now();
        if (!rows.length) {
            el.appendChild(_el('div', 'ui-headline', 'No imaging pass in the next 7 days.'));
        } else {
            const f = rows[0];
            el.appendChild(_el('div', 'ui-headline', `${f.label} is next, ${SatPasses.fmtIn(f.t - now)} (${SatPasses.fmtIst(f.t)})${f.outlook ? `: ${f.outlook.charAt(0).toLowerCase()}${f.outlook.slice(1)}` : ''}.`));
            rows.slice(0, 8).forEach(r => el.appendChild(_el('div', 'disha-scan-row', `${r.label} · ${SatPasses.fmtIst(r.t)} · ${r.meta.res}${r.outlook ? ` · ${r.outlook}` : ''}`)));
        }
        el.appendChild(_el('div', 'disha-scan-hint', 'Orbits: CelesTrak elements, accurate to a few km. Clouds: Open-Meteo hourly forecast. Sentinel-1 and Cartosat follow acquisition plans, so their passes are chances. Turn on Satellites in Layers to see the tracks.'));
        return `Next satellite passes over ${where}:\n${SatPasses.toText(rows, now)}`;
    }

    /** What the live feeds say about the selected cell or the view right now (js/live-now.js). */
    async function _liveAnswer(el, cell) {
        if (typeof LiveNow === 'undefined' || !LiveNow.gather) { el.textContent = 'The live feeds module did not load.'; return ''; }
        el.textContent = 'Checking the live feeds…';
        let s;
        try {
            s = await LiveNow.gather(cell && cell.center ? { lat: cell.center.lat, lng: cell.center.lng, code: cell.code } : undefined);
        } catch {
            el.textContent = 'The map is not ready yet; try again in a moment.';
            return '';
        }
        el.textContent = '';
        const where = cell && cell.code ? DigiPin.format(cell.code) : 'the map centre';
        el.appendChild(_el('div', 'disha-scan-header', `Live now · ${where}`));
        const n = s.correlations.length;
        el.appendChild(_el('div', 'ui-headline', n
            ? `${n} thing${n > 1 ? 's' : ''} in the live feeds line${n > 1 ? '' : 's'} up with the people or hazards here.`
            : 'Nothing in the live feeds lines up with the people or hazards here right now.'));
        s.correlations.slice(0, 6).forEach(c => el.appendChild(_el('div', 'disha-scan-row', `${c.icon || ''} ${c.title}: ${c.detail}`.trim())));
        const facts = [];
        if (s.weather) facts.push(`${Math.round(s.weather.temp)}°C, ${LiveNow.weatherLabel(s.weather.code).text.toLowerCase()}`);
        if (s.air) facts.push(`AQI ${s.air.naqi} (${s.air.band.label})`);
        if (s.gnss) facts.push(`GPS accuracy ${s.gnss.label.toLowerCase()}`);
        if (facts.length) el.appendChild(_el('div', 'disha-scan-row', facts.join(' · ')));
        const ok = s.checks.filter(c => c[1]).length;
        el.appendChild(_el('div', 'disha-scan-hint', `Checked ${ok} of ${s.checks.length} live feeds (Open-Meteo weather, air and river; USGS; NASA EONET; NOAA SWPC; DigiPin cells). Turn on Live now in Layers to see them on the map.`));
        return `Live conditions at ${where}:\n${LiveNow.toText(s)}`;
    }

    function _render(el, r) {
        const head = _el('div', 'disha-scan-header');
        const P = typeof InsightsPanel !== 'undefined' ? InsightsPanel : null;
        if (r.kind === 'insights') {
            head.textContent = 'What stands out';
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', r.headline));
            if (P) r.findings.forEach(f => el.appendChild(P.findingCard(f, { compact: true })));
            el.appendChild(_openButton('Open full insights', 'here'));
        } else if (r.kind === 'changes') {
            head.textContent = `What changed in ${r.cityLabel} · latest ${r.latest}`;
            el.appendChild(head);
            r.items.forEach(x => el.appendChild(_el('div', 'disha-scan-row', `${x.title}. ${x.detail}`)));
            el.appendChild(_openButton('Open the city dashboard', 'city'));
        } else if (r.kind === 'where') {
            const u = r.item.unit;
            head.textContent = `Where ${r.item.label} ${r.dir === 'up' ? 'rose' : 'fell'} most · ${r.cityLabel}, ${r.layer.vs} → ${r.layer.step}`;
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', `City mean ${UrbanInsights.fmt(r.item.prev, u)} → ${UrbanInsights.fmt(r.item.latest, u)}; ${r.layer.rose} cells rose and ${r.layer.fell} fell.`));
            r.top.forEach(t => el.appendChild(_el('div', 'disha-scan-row', `${t.digipin} · ${t.change > 0 ? '+' : ''}${UrbanInsights.fmt(t.change, u)}`)));
            const b = _el('button', 'ui-chip', 'Outline these cells');
            b.type = 'button';
            b.addEventListener('click', () => { if (typeof InsightsPanel !== 'undefined') InsightsPanel.highlight(r.top.map(t => ({ code: t.code, kind: !r.item.higherIs ? 'anomaly' : (r.dir === 'up') === (r.item.higherIs === 'worse') ? 'concern' : 'strength' })), { fit: true }); });
            el.appendChild(b);
        } else if (r.kind === 'tour') {
            head.textContent = `Briefing · ${r.cityLabel}`;
            el.appendChild(head);
            r.stops.filter(x => x.id !== 'end').forEach(x => el.appendChild(_el('div', 'disha-scan-row', `${x.label}: ${x.caption}`)));
            const b = _el('button', 'ui-chip ui-chip--primary', r.play ? '▶ Replay the 3D tour' : '▶ Fly the 3D tour');
            b.type = 'button';
            b.addEventListener('click', () => CityTour.play(r.city, CellStore));
            el.appendChild(b);
        } else if (r.kind === 'dashboard') {
            head.textContent = 'City rankings';
            el.appendChild(head);
            r.cities.forEach(c => el.appendChild(_el('div', 'disha-scan-row', `${c.rank}. ${c.label} · urban index ${c.index} · best at ${c.strengths.map(s => s.label.toLowerCase()).join(', ')}`)));
            el.appendChild(_openButton('Open the city dashboard', 'city'));
        } else if (r.kind === 'compare') {
            head.textContent = `${r.a.label} vs ${r.b.label}`;
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', r.summary));
            r.rows.slice(0, 6).forEach(x => el.appendChild(_el('div', 'disha-scan-row',
                `${x.label}: ${UrbanInsights.fmt(x.a, x.unit)} vs ${UrbanInsights.fmt(x.b, x.unit)}${x.winner === 'a' ? ` (${r.a.label})` : x.winner === 'b' ? ` (${r.b.label})` : ''}`)));
            el.appendChild(_openButton('Open the comparison', 'compare'));
        } else if (r.kind === 'siting') {
            head.textContent = `${r.st.title} · ${r.cityLabel}`;
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', r.st.headline));
            r.st.sites.slice(0, 5).forEach(x => el.appendChild(_el('div', 'disha-scan-row', `${x.rank}. ${DigiPin.format(x.code)} · score ${x.score} · ${x.why}`)));
            el.appendChild(_el('div', 'disha-scan-hint', `Weights (AHP, CR ${r.st.consistency}): ${r.st.weights.map(w => `${w.label} ${Math.round(w.weight * 100)}%`).join(', ')}`));
            el.appendChild(_openButton('Open the lenses', 'lenses'));
        } else if (r.kind === 'lenses') {
            head.textContent = `Urban lenses · ${r.cityLabel}`;
            el.appendChild(head);
            for (const l of r.lenses.filter(x => !r.only || r.only.includes(x.id))) {
                el.appendChild(_el('div', 'ui-headline', `${l.icon} ${l.title}`));
                el.appendChild(_el('div', 'disha-scan-row', l.headline));
                const bits = [];
                if (l.equity && l.equity.gini != null) bits.push(`Gini ${l.equity.gini} across residents`);
                if (l.hotspots && l.hotspots.moranI != null) bits.push(`${l.hotspots.reading} (Moran’s I ${l.hotspots.moranI})`);
                if (bits.length) el.appendChild(_el('div', 'disha-scan-hint', bits.join(' · ')));
                if (r.only) el.appendChild(_el('div', 'disha-scan-hint', `Method: ${l.method}`));
            }
            el.appendChild(_openButton('Open the lenses', 'lenses'));
        } else if (r.kind === 'mobilityscore') {
            head.textContent = `${r.sc.title || 'Mobility scorecard'} · ${r.sc.cities.length} cities`;
            el.appendChild(head);
            const me = r.city && r.sc.cities.find(x => x.city === r.city);
            el.appendChild(_el('div', 'ui-headline', me ? `${me.label} ranks ${me.rank} of ${r.sc.cities.length} (${me.overall}/100); strongest on ${me.best.label.replace(/^./, ch => ch.toLowerCase())}, weakest on ${me.worst.label.replace(/^./, ch => ch.toLowerCase())}.`
                : `${r.sc.cities[0].label} leads (${r.sc.cities[0].overall}/100); ${r.sc.cities[r.sc.cities.length - 1].label} trails (${r.sc.cities[r.sc.cities.length - 1].overall}/100).`));
            r.sc.cities.forEach(x => el.appendChild(_el('div', `disha-scan-row${x.city === r.city ? ' is-current' : ''}`,
                `${x.rank}. ${x.label} ${x.overall} · ${r.sc.pillars.map(p => `${p.label} ${x.pillars[p.id] ?? '–'}`).join(' · ')}`)));
            el.appendChild(_el('div', 'disha-scan-hint', `${r.sc.note ? r.sc.note.replace(/\.$/, '') : 'Each measure scores 0–100 between the worst and best city; pillars average their measures'} (${r.sc.pillars.map(p => `${p.label}: ${p.metrics.map(id => r.sc.metrics[id].label.replace(/^./, ch => ch.toLowerCase())).join(', ')}`).join('; ')}).`));
            el.appendChild(_openButton('Open the lenses', 'lenses'));
        } else if (r.kind === 'whereis') {
            head.textContent = `${DigiPin.format(r.code)} · ${r.cityLabel}`;
            el.appendChild(head);
            whereText(r).split('\n').forEach(line => el.appendChild(_el('div', 'disha-scan-row', line)));
        } else if (r.kind === 'propreport') {
            head.textContent = `Property report · ${DigiPin.format(r.m.code)} · ${r.m.cityLabel}`;
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', r.m.verdict));
            for (const s of r.m.sections) el.appendChild(_el('div', 'disha-scan-row', `${s.title}: ${s.rows.slice(0, 3).map(x => `${x.label} ${x.value}`).join(' · ')}`));
            const b = _el('button', 'disha-scan-export', 'Open the printable report');
            b.type = 'button';
            b.addEventListener('click', () => PropertyReport.open(r.m));
            el.appendChild(b);
        } else if (r.kind === 'similarall') {
            head.textContent = 'Places like this in every city';
            el.appendChild(head);
            const [first, ...rest] = UrbanLenses.similarEverywhereText(r.s).split('\n');
            el.appendChild(_el('div', 'ui-headline', first));
            rest.forEach(line => el.appendChild(_el('div', 'disha-scan-row', line)));
            el.appendChild(_el('div', 'disha-scan-hint', 'Each city\'s best match on percentiles within its own city: land value (double weight), density, job reach, metro walk, wealth, shops, newness, high-rise share, greenery, roof cover, surface heat and flood exposure, smoothed over 500 m.'));
        } else if (r.kind === 'similar') {
            head.textContent = 'Places like this';
            el.appendChild(head);
            const [first, ...rest] = UrbanLenses.similarText(r.s).split('\n');
            el.appendChild(_el('div', 'ui-headline', first));
            rest.forEach(line => el.appendChild(_el('div', 'disha-scan-row', line)));
            el.appendChild(_el('div', 'disha-scan-hint', 'Matched on each block\'s percentile within its own city (land value counts double): land value, density, job reach, metro walk, wealth, shops, newness, high-rise share, greenery, roof cover, surface heat and flood exposure, smoothed over 500 m.'));
        } else if (r.kind === 'lookalike') {
            head.textContent = 'Looks like this from space';
            el.appendChild(head);
            const [first, ...rest] = UrbanLenses.lookalikeText(r.s).split('\n');
            el.appendChild(_el('div', 'ui-headline', first));
            rest.forEach(line => el.appendChild(_el('div', 'disha-scan-row', line)));
            el.appendChild(_el('div', 'disha-scan-hint', 'Matched on Google\'s AlphaEarth satellite embeddings for 2025 (12 principal components shared by all cities), which capture built form, roofs, greenery and water but not prices or people.'));
        } else if (r.kind === 'farwhatif') {
            head.textContent = `FAR what-if · ${DigiPin.format(r.f.code)} · ${r.cityLabel}`;
            el.appendChild(head);
            const [first, ...rest] = UrbanLenses.farText(r.f).split('\n');
            el.appendChild(_el('div', 'ui-headline', first));
            rest.forEach(line => el.appendChild(_el('div', 'disha-scan-row', line)));
            el.appendChild(_el('div', 'disha-scan-hint', 'Residual valuation: sales (city-average price × the block\'s value index, 1.25 loading) − build cost (CPWD rates, +3% a storey above four, 15% soft costs) − 20% margin. Base FAR is the city\'s typical master-plan level, not this plot\'s zoning.'));
        } else if (r.kind === 'stationwhatif') {
            head.textContent = `Metro station what-if · ${r.cityLabel}`;
            el.appendChild(head);
            const [first, ...rest] = stationText(r).split('\n');
            el.appendChild(_el('div', 'ui-headline', first));
            rest.forEach(line => el.appendChild(_el('div', 'disha-scan-row', line)));
            el.appendChild(_el('div', 'disha-scan-hint', 'Catchment = 10-minute walk (straight line × 1.3 at 4.8 km/h). Track alignment and cost are not considered.'));
            if (r.s.sites.length && typeof MapModule !== 'undefined' && MapModule.selectByCode) {
                el.appendChild(_el('div', 'disha-scan-hint', `Open a site: ${r.s.sites.map(x => DigiPin.format(x.code)).join(', ')}`));
            }
        } else if (r.kind === 'roadwhatif') {
            const a = r.a;
            head.textContent = !a.ok ? 'Road what-if' : a.buslane ? `Bus-lane what-if · ${a.road} · ${a.shift.pct}% switch · ${a.period === 'pm' ? '18:00' : '09:00'}` : a.shift ? `Mode-shift what-if · ${a.shift.pct}% ${a.shift.scope === 'all' ? 'of all car trips' : 'near stations'} · ${a.period === 'pm' ? '18:00' : '09:00'}` : a.monsoon ? `Monsoon what-if · ${a.label} · ${a.period === 'pm' ? '18:00' : '09:00'}`
                : `Road what-if · ${a.action === 'widen' ? 'widen' : 'close'} ${a.road} · ${a.period === 'pm' ? '18:00' : '09:00'}`;
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', a.ok ? a.headline : a.error));
            if (a.ok) {
                const row = (x) => `${x.name}: V/C ${x.base.toFixed(2)} → ${x.scen.toFixed(2)}`;
                if (a.worse.length) el.appendChild(_el('div', 'disha-scan-row', `Busier: ${a.worse.map(row).join(' · ')}`));
                if (a.better.length) el.appendChild(_el('div', 'disha-scan-row', `Quieter: ${a.better.map(row).join(' · ')}`));
                el.appendChild(_el('div', 'disha-scan-hint', 'Commute re-routed on the modelled arterials (destinations fixed). Edit it in the What-if panel by the Traffic legend.'));
            }
        } else if (r.kind === 'whatif') {
            head.textContent = r.title;
            el.appendChild(head);
            el.appendChild(_el('div', 'ui-headline', r.summary));
            r.metrics.forEach(m => el.appendChild(_el('div', 'disha-scan-row', `${m.label}: ${m.value != null ? m.value : `${m.before} → ${m.after}`}`)));
            el.appendChild(_el('div', 'disha-scan-hint', `Formula: ${r.formula}`));
            el.appendChild(_openButton('Open in What-if', 'whatif'));
        }
        if (r.sources && r.sources.length) {
            el.appendChild(_el('div', 'disha-scan-hint', `Sources: ${r.sources.map(s => s.title).join(' · ')}`));
        }
    }

    /** Cited evidence for the selected cell, or { text:'', citations:[] }. */
    async function evidence(cell) {
        if (!cell || !cell.center || typeof UrbanInsights === 'undefined' || typeof CellStore === 'undefined' || !CellStore.isEnabled()) {
            return { text: '', citations: [] };
        }
        try { return await UrbanInsights.evidence(cell.center.lat, cell.center.lng, CellStore); } catch { return { text: '', citations: [] }; }
    }

    /**
     * Replace [C#] tags in a rendered reply with chips that open the cited
     * dataset's source card, and add a "Sources" line for what was cited.
     */
    function decorate(el, citations) {
        if (!el || !citations || !citations.length || typeof document === 'undefined') return [];
        const byTag = new Map(citations.map(c => [c.tag, c]));
        const used = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) if (/\[C\d{1,2}\]/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
        for (const node of nodes) {
            const frag = document.createDocumentFragment();
            const parts = node.nodeValue.split(/(\[C\d{1,2}\])/);
            for (const part of parts) {
                const m = /^\[(C\d{1,2})\]$/.exec(part);
                const c = m && byTag.get(m[1]);
                if (!c) { frag.appendChild(document.createTextNode(part)); continue; }
                if (!used.includes(c)) used.push(c);
                const chip = _el('button', 'disha-cite', c.tag);
                chip.type = 'button';
                chip.title = `${c.title}: ${c.source}${c.license ? ` (${c.license})` : ''}`;
                chip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const next = chip.nextElementSibling;
                    if (next && next.classList.contains('source-card')) { next.remove(); return; }
                    if (typeof Provenance === 'undefined') return;
                    const spec = CellStore.get(c.id);
                    const card = Provenance.renderCard(spec ? Provenance.fromSpec(spec, CellStore.generated(), CellStore.isLocal(c.id)) : { source: c.source, license: c.license });
                    chip.insertAdjacentElement('afterend', card);
                });
                frag.appendChild(chip);
            }
            node.parentNode.replaceChild(frag, node);
        }
        if (used.length) {
            const src = _el('div', 'disha-cite-sources', `Cited: ${used.map(c => `${c.tag} ${c.title}`).join(' · ')}`);
            el.appendChild(src);
        }
        return used;
    }

    return { match, roadAsk, stationText, citiesIn, citeTags, answer, evidence, decorate, whereChanged, cities: _cities };
})();

if (typeof window !== 'undefined') {
    window.DishaIntel = DishaIntel;
}
