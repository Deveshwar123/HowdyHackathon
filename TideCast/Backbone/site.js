// TideCast shared header: one logo + navigation for every page (home, catch, leaderboard,
// species and the atlas). Pages mark where it goes with <header data-site-header></header>;
// without one (the atlas), it is added to the top of <body>.
(() => {
  const LINKS = [
    { href: '/', label: 'Explore', match: (p) => p === '/' || p === '/index.html' },
    { href: '/backbone/leaderboard.html', label: 'Leaderboard', match: (p) => p.endsWith('/leaderboard.html') },
    { href: '/backbone/species.html', label: 'Species', match: (p) => p.endsWith('/species.html') },
    { href: '/backbone/#program', label: 'How it works', id: 'nav-how', match: () => false },
    { href: '/backbone/catch.html', label: 'Log a catch', cta: true, match: (p) => p.endsWith('/catch.html') },
  ];
  const LOGO = `<svg viewBox="0 0 64 40" width="58" height="36" aria-hidden="true">
      <defs><linearGradient id="tc-lg" x1="0" x2="1"><stop offset="0" stop-color="#b90101"/><stop offset="1" stop-color="#8c0327"/></linearGradient></defs>
      <path d="M3 11c7-7 14-7 21 0s14 7 21 0 11-6 16-2" fill="none" stroke="url(#tc-lg)" stroke-width="3.2" stroke-linecap="round"/>
      <path d="M3 21c7-7 14-7 21 0s14 7 21 0 11-6 16-2" fill="none" stroke="url(#tc-lg)" stroke-width="3.2" stroke-linecap="round"/>
      <path d="M3 31c7-7 14-7 21 0s14 7 21 0 11-6 16-2" fill="none" stroke="url(#tc-lg)" stroke-width="3.2" stroke-linecap="round"/>
    </svg>`;
  const path = location.pathname;
  // Without a placeholder (the atlas, whose body React owns), the header is appended: it's fixed.
  const header = document.querySelector('[data-site-header]') || document.body.appendChild(document.createElement('header'));
  header.className = 'site-header';
  header.innerHTML = `
    <a class="logo" href="/backbone/" aria-label="TideCast home">${LOGO}<span>TIDECAST</span></a>
    <button class="menu-btn" type="button" aria-label="Menu" aria-expanded="false"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
    <nav aria-label="Main">${LINKS.map((l) => `<a href="${l.href}"${l.id ? ` id="${l.id}"` : ''} class="${[l.cta ? 'nav-cta' : '', l.match(path) ? 'active' : ''].join(' ').trim()}"${l.match(path) ? ' aria-current="page"' : ''}>${l.label}</a>`).join('')}</nav>`;
  const btn = header.querySelector('.menu-btn');
  const setOpen = (open) => {
    header.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', () => setOpen(!header.classList.contains('open')));
  header.querySelectorAll('nav a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  document.addEventListener('click', (e) => { if (!header.contains(e.target)) setOpen(false); });
  // Glass behind the header once the page scrolls (pages can also force it with data-glass).
  const glass = () => header.classList.toggle('glass', header.hasAttribute('data-glass') || scrollY > 8 || document.body.classList.contains('in-water'));
  addEventListener('scroll', glass, { passive: true });
  new MutationObserver(glass).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  glass();
  window.TideCastHeader = header;
})();
