// Motyw ustawiany przed pobraniem pakietu aplikacji. main.tsx robi to samo,
// ale dopiero po pobraniu JS - do tego czasu ciemny motyw startowal od bialego
// ekranu. Plik zewnetrzny, bo CSP wersji desktopowej blokuje skrypty inline.
// Ta sama kolejnosc co odczytajMotyw(): najpierw portfel, potem warsztat.
(function () {
  try {
    var portfel = localStorage.getItem('pit38_theme');
    var motyw = portfel === 'dark' || portfel === 'light'
      ? portfel
      : (localStorage.getItem('theme') === 'dark' ? 'dark' : 'light');
    if (motyw === 'dark') document.documentElement.classList.add('dark');
  } catch (e) {
    // Bez localStorage zostaje jasny start; main.tsx i tak ustawi motyw.
  }
})();
