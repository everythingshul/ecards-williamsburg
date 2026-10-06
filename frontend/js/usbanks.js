// A curated list of US banks for the payment-info bank picker (store-portal
// billing). There's no free, redistributable feed of real bank logo
// artwork/trademarks to pull from, and this app has no reliable outbound
// fetch for arbitrary third-party images anyway — so instead of scraping
// logos, renderBankLogo() below generates a consistent, deterministic
// colored monogram per bank name (same idea Plaid's own picker UX uses:
// icon + name in a searchable list), which looks clean and never 404s.
// "Don't see your bank?" always falls back to a free-text name field (see
// store-portal/billing.html) so this list is never a hard wall.
window.US_BANKS = [
  'Chase', 'Bank of America', 'Wells Fargo', 'Citibank', 'U.S. Bank', 'PNC Bank', 'Truist Bank',
  'Capital One', 'TD Bank', 'Citizens Bank', 'Fifth Third Bank', 'Regions Bank', 'M&T Bank',
  'KeyBank', 'Huntington Bank', 'Santander Bank', 'BMO Bank', 'Ally Bank', 'Discover Bank',
  'American Express Bank', 'USAA Bank', 'Navy Federal Credit Union', 'Synchrony Bank',
  'First Republic Bank', 'Comerica Bank', 'Zions Bank', 'East West Bank', 'Associated Bank',
  'Webster Bank', 'Popular Bank', 'Flagstar Bank', 'Valley National Bank', 'OceanFirst Bank',
  'Provident Bank', 'Investors Bank', 'ConnectOne Bank', 'Columbia Bank', 'Kearny Bank',
  'Spencer Savings Bank', 'Two River Community Bank', 'Lakeland Bank', 'Peapack-Gladstone Bank',
  'Cross River Bank', 'NJM Bank', 'Blue Foundry Bank', 'Unity Bank', 'Northfield Bank',
  'Metuchen Savings Bank', 'Magyar Bank', 'Millington Bank', 'Freedom Bank',
  'Signature Bank', 'Apple Bank for Savings', 'Dime Community Bank', 'Ridgewood Savings Bank',
  'Emigrant Bank', 'Flushing Bank', 'Berkshire Bank', 'New York Community Bank', 'Esquire Bank',
  'Israel Discount Bank of New York', 'Bank Leumi USA', 'Bank Hapoalim', 'Mizrahi Tefahot Bank',
  'Amalgamated Bank', 'Northwest Bank', 'Chemung Canal Trust', 'NBT Bank', 'Tompkins Trust',
  'Sterling National Bank', 'Customers Bank', 'First Horizon Bank', 'Synovus Bank',
  'South State Bank', 'BankUnited', 'City National Bank', 'EverBank', 'Umpqua Bank',
  'Old National Bank', 'First Interstate Bank', 'Glacier Bank', 'WaFd Bank', 'Hancock Whitney Bank',
  'Simmons Bank', 'Renasant Bank', 'Pinnacle Bank', 'FirstBank', 'Frost Bank', 'Prosperity Bank',
  'Charles Schwab Bank', 'Goldman Sachs Bank (Marcus)', 'Morgan Stanley Private Bank',
  'Credit Union 1', 'Alliant Credit Union', 'Pentagon Federal Credit Union (PenFed)',
  'State Employees Credit Union', 'Other / Not Listed',
];

// Deterministic HSL color from the bank name so the same bank always gets
// the same tile color across renders, without storing a color anywhere.
function _bankColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue}, 58%, 42%)`;
}
function _bankInitials(name) {
  const words = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(w => !['of', 'for', 'the', 'and', '&', 'USA'].includes(w));
  return (words.slice(0, 2).map(w => w[0]).join('') || name[0] || '?').toUpperCase();
}
window.renderBankLogo = function renderBankLogo(name, size = 36) {
  const color = _bankColor(name);
  const initials = _bankInitials(name);
  const fontSize = Math.round(size * 0.4);
  return `<span class="bank-logo" style="width:${size}px;height:${size}px;min-width:${size}px;border-radius:${Math.round(size * 0.28)}px;background:${color};color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:${fontSize}px;font-family:Georgia,serif;letter-spacing:0.5px">${initials}</span>`;
};
