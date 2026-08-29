// Fallback geocoder: the LLM leaves lat/lon null for most events, so we resolve
// a place name against a static table of Ukrainian oblast centres, front-line
// towns, and Russian deep-strike target cities. Coordinates are [lat, lon],
// settlement-centroid precision — good enough for a 0.5-degree map.

type LL = [number, number];

const PLACES: Record<string, LL> = {
  // Ukraine — capital & oblast centres
  "kyiv": [50.4501, 30.5234], "kiev": [50.4501, 30.5234],
  "kharkiv": [49.9935, 36.2304], "kharkov": [49.9935, 36.2304],
  "odesa": [46.4825, 30.7233], "odessa": [46.4825, 30.7233],
  "dnipro": [48.4647, 35.0462], "dnipropetrovsk": [48.4647, 35.0462],
  "donetsk": [48.0159, 37.8028], "luhansk": [48.5740, 39.3078], "lugansk": [48.5740, 39.3078],
  "zaporizhzhia": [47.8388, 35.1396], "zaporozhye": [47.8388, 35.1396], "zaporizhia": [47.8388, 35.1396],
  "lviv": [49.8397, 24.0297], "kherson": [46.6354, 32.6169],
  "mykolaiv": [46.9750, 31.9946], "nikolaev": [46.9750, 31.9946],
  "vinnytsia": [49.2331, 28.4682], "chernihiv": [51.4982, 31.2893],
  "sumy": [50.9077, 34.7981], "poltava": [49.5883, 34.5514],
  "cherkasy": [49.4444, 32.0598], "zhytomyr": [50.2547, 28.6587],
  "rivne": [50.6199, 26.2516], "lutsk": [50.7472, 25.3254],
  "ternopil": [49.5535, 25.5948], "khmelnytskyi": [49.4229, 26.9871],
  "ivano-frankivsk": [48.9226, 24.7111], "uzhhorod": [48.6208, 22.2879],
  "chernivtsi": [48.2921, 25.9358], "kropyvnytskyi": [48.5079, 32.2623],
  "kirovohrad": [48.5079, 32.2623],
  "simferopol": [44.9521, 34.1024], "sevastopol": [44.6167, 33.5254],
  "kramatorsk": [48.7389, 37.5848], "sloviansk": [48.8642, 37.6111], "slaviansk": [48.8642, 37.6111],
  // Ukraine — front-line / frequently struck towns
  "pokrovsk": [48.2814, 37.1761], "myrnohrad": [48.3050, 37.2653],
  "bakhmut": [48.5947, 38.0075], "avdiivka": [48.1394, 37.7492],
  "kostiantynivka": [48.5277, 37.7089], "kostyantynivka": [48.5277, 37.7089],
  "chasiv yar": [48.5906, 37.8347], "toretsk": [48.3986, 37.8556],
  "kupiansk": [49.7103, 37.6156], "kupyansk": [49.7103, 37.6156],
  "vovchansk": [50.2894, 36.9439], "izium": [49.2126, 37.2506], "izyum": [49.2126, 37.2506],
  "lyman": [48.9877, 37.8028], "vuhledar": [47.7797, 37.2497], "ugledar": [47.7797, 37.2497],
  "orikhiv": [47.5678, 35.7856], "robotyne": [47.4453, 35.8331],
  "hulyaipole": [47.6647, 36.2544], "huliaipole": [47.6647, 36.2544],
  "marhanets": [47.6431, 34.6289], "nikopol": [47.5709, 34.3919],
  "kramators'k": [48.7389, 37.5848], "druzhkivka": [48.6183, 37.5278],
  "snihurivka": [47.0761, 32.8072], "kramatorsk raion": [48.7389, 37.5848],
  "pavlohrad": [48.5350, 35.8700], "pavlograd": [48.5350, 35.8700],
  "kryvyi rih": [47.9105, 33.3918], "krivoy rog": [47.9105, 33.3918],
  "enerhodar": [47.4986, 34.6586], "energodar": [47.4986, 34.6586],
  "berdiansk": [46.7553, 36.7885], "melitopol": [46.8489, 35.3653],
  "mariupol": [47.0958, 37.5494], "makiivka": [48.0478, 37.9258], "makeyevka": [48.0478, 37.9258],
  "horlivka": [48.3336, 38.0925], "gorlovka": [48.3336, 38.0925],
  "kurakhove": [47.9847, 37.2789], "selydove": [48.1447, 37.2919],
  // Russia — deep-strike target cities (refineries, airfields, depots, ports)
  "belgorod": [50.5997, 36.5983], "kursk": [51.7373, 36.1874],
  "bryansk": [53.2521, 34.3717], "voronezh": [51.6720, 39.1843],
  "rostov-on-don": [47.2357, 39.7015], "rostov": [47.2357, 39.7015],
  "taganrog": [47.2362, 38.8969], "novorossiysk": [44.7239, 37.7708],
  "tuapse": [44.0969, 39.0764], "sochi": [43.5855, 39.7231],
  "yeysk": [46.7104, 38.2769], "primorsko-akhtarsk": [46.0503, 38.1786],
  "slavyansk-on-kuban": [45.2578, 38.1281], "krasnodar": [45.0355, 38.9753],
  "yaroslavl": [57.6261, 39.8845], "ryazan": [54.6295, 39.7415],
  "tver": [56.8587, 35.9176], "smolensk": [54.7818, 32.0401],
  "kaluga": [54.5293, 36.2754], "tula": [54.1961, 37.6182],
  "lipetsk": [52.6088, 39.5992], "tambov": [52.7212, 41.4523],
  "volgograd": [48.7080, 44.5133], "saratov": [51.5924, 46.0348],
  "engels": [51.4839, 46.1264], "samara": [53.2415, 50.2212],
  "syzran": [53.1585, 48.4741], "novokuybyshevsk": [53.0955, 49.9457],
  "kazan": [55.8304, 49.0661], "yelabuga": [55.7628, 52.0575], "elabuga": [55.7628, 52.0575],
  "nizhny novgorod": [56.2965, 43.9361], "kstovo": [56.1497, 44.1750],
  "ukhta": [63.5667, 53.6833], "ust-luga": [59.6717, 28.2611],
  "millerovo": [48.9224, 40.3969], "morozovsk": [48.3517, 41.8281],
  "novoshakhtinsk": [47.7583, 39.9203], "kamensk-shakhtinsky": [48.3181, 40.2669],
  "feodosia": [45.0319, 35.3824], "kerch": [45.3561, 36.4675],
  "dzhankoi": [45.7092, 34.3931], "dzhankoy": [45.7092, 34.3931],
  "saky": [45.1350, 33.5992], "yevpatoria": [45.1904, 33.3669],
  "moscow": [55.7558, 37.6173], "saint petersburg": [59.9311, 30.3609],
  "st petersburg": [59.9311, 30.3609], "pskov": [57.8194, 28.3320],
};

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\boblast\b|\braion\b|\bregion\b|\bdistrict\b|\bcity of\b/g, "")
    .replace(/['`’.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Return [lat, lon] for a place name, or null. Tries the whole string, then
 *  each comma-separated part, then a leading-word prefix match. */
export function geocode(name: string | null | undefined): LL | null {
  if (!name) return null;
  const whole = norm(name);
  if (PLACES[whole]) return PLACES[whole];
  for (const part of whole.split(",")) {
    const p = part.trim();
    if (PLACES[p]) return PLACES[p];
  }
  for (const key of Object.keys(PLACES)) {
    if (whole === key || whole.startsWith(key + " ") || whole.endsWith(" " + key)) {
      return PLACES[key];
    }
  }
  return null;
}
