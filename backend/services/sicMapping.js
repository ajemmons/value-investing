/**
 * Map SEC SIC (Standard Industrial Classification) codes to coarse sectors and
 * readable industries. SEC reports a SIC code per filer; we bucket it so the
 * diversification engine can reason about sector concentration without a paid
 * GICS feed. Buckets intentionally flag the cyclical themes called out in the
 * spec (financials, technology, aerospace, energy).
 */

/**
 * @param {number|string} sic 4-digit SIC code
 * @param {string} [description] SEC's sicDescription, used as industry label
 * @returns {{sector:string, industry:string, cyclicalTheme:string|null}}
 */
export function classifySic(sic, description = '') {
  const code = parseInt(sic, 10);
  const industry = description || 'Unknown';
  let sector = 'Other';
  let cyclicalTheme = null;

  if (!Number.isFinite(code)) return { sector: 'Unknown', industry, cyclicalTheme };

  // Ranges per the SIC division/major-group structure. NOTE: narrower, more
  // specific ranges (e.g. pharmaceuticals, computers) are checked BEFORE the
  // broad ranges that would otherwise shadow them.
  if (code >= 100 && code <= 999) sector = 'Agriculture';
  else if (code >= 1000 && code <= 1499) {
    sector = 'Energy & Materials';
    cyclicalTheme = 'energy';
  } else if (code >= 1500 && code <= 1799) sector = 'Construction';
  else if (code >= 2000 && code <= 2199) sector = 'Consumer Staples'; // food
  else if (code >= 2300 && code <= 2399) sector = 'Consumer Discretionary';
  else if (code >= 2830 && code <= 2836) sector = 'Healthcare'; // drugs/biotech (before chemicals)
  else if (code >= 2800 && code <= 2899) sector = 'Materials'; // chemicals
  else if (code >= 2900 && code <= 2999) {
    sector = 'Energy & Materials';
    cyclicalTheme = 'energy';
  } else if (code >= 3000 && code <= 3399) sector = 'Materials';
  else if (code >= 3440 && code <= 3499) sector = 'Industrials';
  else if (code >= 3570 && code <= 3579) {
    sector = 'Technology'; // computer & office equipment (before broad machinery)
    cyclicalTheme = 'technology';
  } else if (code >= 3500 && code <= 3599) sector = 'Industrials';
  else if (code >= 3600 && code <= 3699) {
    sector = 'Technology';
    cyclicalTheme = 'technology';
  } else if (code >= 3700 && code <= 3719) {
    sector = 'Industrials';
    cyclicalTheme = 'automotive';
  } else if (code >= 3720 && code <= 3729) {
    sector = 'Industrials';
    cyclicalTheme = 'aerospace';
  } else if (code >= 3760 && code <= 3769) {
    sector = 'Industrials';
    cyclicalTheme = 'aerospace';
  } else if (code >= 3840 && code <= 3851) {
    sector = 'Healthcare'; // surgical/medical/dental instruments (before broad instruments)
  } else if (code >= 3800 && code <= 3899) {
    sector = 'Technology';
    cyclicalTheme = 'technology';
  } else if (code >= 3900 && code <= 3999) sector = 'Consumer Discretionary';
  else if (code >= 4000 && code <= 4799) sector = 'Industrials'; // transport
  else if (code >= 4800 && code <= 4899) sector = 'Communication Services';
  else if (code >= 4900 && code <= 4999) sector = 'Utilities';
  else if (code >= 5000 && code <= 5199) sector = 'Consumer Discretionary';
  else if (code >= 5200 && code <= 5999) sector = 'Consumer Discretionary'; // retail
  else if (code >= 6000 && code <= 6499) {
    sector = 'Financials';
    cyclicalTheme = 'financials';
  } else if (code >= 6500 && code <= 6599) {
    sector = 'Real Estate';
    cyclicalTheme = 'real-estate';
  } else if (code >= 6700 && code <= 6799) {
    sector = 'Financials';
    cyclicalTheme = 'financials';
  } else if (code >= 7000 && code <= 7299) sector = 'Consumer Discretionary';
  else if (code >= 7370 && code <= 7379) {
    sector = 'Technology';
    cyclicalTheme = 'technology';
  } else if (code >= 7300 && code <= 7399) sector = 'Technology';
  else if (code >= 7800 && code <= 7999) sector = 'Communication Services';
  else if (code >= 8000 && code <= 8099) sector = 'Healthcare';
  else sector = 'Other';

  return { sector, industry, cyclicalTheme };
}
