// public/download.js — tab OS di halaman unduh.
//
// Dulunya skrip ini inline di download.html. CSP aplikasi memakai
// `script-src 'self'`, jadi skrip inline tidak pernah dijalankan dan tab
// "Linux / macOS" mati tanpa pesan apa pun. Dipindah ke berkas terpisah
// supaya CSP tetap ketat.
const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];

function selectTab(selected, focus = false) {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    if (panel) panel.hidden = !active;
  }
  if (focus) selected.focus();
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    let next;
    switch (event.key) {
      case 'ArrowRight': next = (index + 1) % tabs.length; break;
      case 'ArrowLeft': next = (index - 1 + tabs.length) % tabs.length; break;
      case 'Home': next = 0; break;
      case 'End': next = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    selectTab(tabs[next], true);
  });
});
