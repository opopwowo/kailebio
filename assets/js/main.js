document.addEventListener('DOMContentLoaded', function () {
  /* ---------- Reveal on scroll ---------- */
  var reveals = document.querySelectorAll('.reveal');
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });
  reveals.forEach(function (el) { observer.observe(el); });

  /* ---------- Nav scroll style + back to top ---------- */
  var nav = document.getElementById('site-nav');
  var backToTop = document.getElementById('back-to-top');
  window.addEventListener('scroll', function () {
    if (window.scrollY > 40) {
      nav.classList.add('shadow-md');
    } else {
      nav.classList.remove('shadow-md');
    }
    if (backToTop) {
      if (window.scrollY > 600) backToTop.classList.add('show');
      else backToTop.classList.remove('show');
    }
  });
  if (backToTop) {
    backToTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  /* ---------- Mobile menu ---------- */
  var menuBtn = document.getElementById('menu-btn');
  var mobileMenu = document.getElementById('mobile-menu');
  if (menuBtn && mobileMenu) {
    menuBtn.addEventListener('click', function () {
      mobileMenu.classList.toggle('open');
    });
    mobileMenu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        mobileMenu.classList.remove('open');
      });
    });
  }

  /* ---------- Counter animation ---------- */
  var counters = document.querySelectorAll('.counter-num');
  var counterObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        counterObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.4 });
  counters.forEach(function (el) { counterObserver.observe(el); });

  function animateCounter(el) {
    var target = parseFloat(el.getAttribute('data-target'));
    var suffix = el.getAttribute('data-suffix') || '';
    var duration = 1600;
    var start = null;
    function step(timestamp) {
      if (!start) start = timestamp;
      var progress = Math.min((timestamp - start) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      var value = target * eased;
      el.textContent = (target % 1 === 0 ? Math.floor(value) : value.toFixed(1)) + suffix;
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ---------- Testimonial carousel ---------- */
  var track = document.getElementById('testimonial-track');
  var dotsWrap = document.getElementById('testimonial-dots');
  if (track) {
    var slides = track.querySelectorAll('.testimonial-slide');
    var index = 0;
    var visible = window.innerWidth >= 1024 ? 3 : (window.innerWidth >= 768 ? 2 : 1);
    var maxIndex = Math.max(slides.length - visible, 0);

    function renderDots() {
      dotsWrap.innerHTML = '';
      for (var i = 0; i <= maxIndex; i++) {
        var dot = document.createElement('button');
        dot.className = 'dot' + (i === index ? ' active' : '');
        dot.setAttribute('aria-label', '見證 ' + (i + 1));
        dot.addEventListener('click', function (i) {
          return function () { goTo(i); };
        }(i));
        dotsWrap.appendChild(dot);
      }
    }

    function goTo(i) {
      index = Math.max(0, Math.min(i, maxIndex));
      var slideWidth = track.children[0].getBoundingClientRect().width;
      track.style.transform = 'translateX(-' + (index * slideWidth) + 'px)';
      Array.prototype.forEach.call(dotsWrap.children, function (d, di) {
        d.classList.toggle('active', di === index);
      });
    }

    renderDots();

    var auto = setInterval(function () {
      var next = index + 1 > maxIndex ? 0 : index + 1;
      goTo(next);
    }, 4500);

    window.addEventListener('resize', function () {
      visible = window.innerWidth >= 1024 ? 3 : (window.innerWidth >= 768 ? 2 : 1);
      maxIndex = Math.max(slides.length - visible, 0);
      index = Math.min(index, maxIndex);
      renderDots();
      goTo(index);
    });
  }

  /* ---------- FAQ accordion ---------- */
  var faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach(function (item) {
    var question = item.querySelector('.faq-question');
    var answer = item.querySelector('.faq-answer');
    question.addEventListener('click', function () {
      var isOpen = item.classList.contains('open');
      faqItems.forEach(function (other) {
        other.classList.remove('open');
        other.querySelector('.faq-answer').style.maxHeight = null;
      });
      if (!isOpen) {
        item.classList.add('open');
        answer.style.maxHeight = answer.scrollHeight + 'px';
      }
    });
  });

  /* ---------- Current year ---------- */
  var yearEl = document.getElementById('current-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- 產品圖燈箱（點擊放大） ---------- */
  var zoomImgs = document.querySelectorAll('.product-img, .zoomable');
  if (zoomImgs.length) {
    var lb = document.createElement('div');
    lb.className = 'lightbox-overlay';
    lb.innerHTML = '<button class="lightbox-close" aria-label="關閉">×</button><img alt="">';
    document.body.appendChild(lb);
    var lbImg = lb.querySelector('img');
    function closeLb() { lb.classList.remove('open'); document.body.style.overflow = ''; }
    zoomImgs.forEach(function (im) {
      im.addEventListener('click', function () {
        lbImg.src = im.currentSrc || im.src;
        lbImg.alt = im.alt || '';
        lb.classList.add('open');
        document.body.style.overflow = 'hidden';
      });
    });
    lb.addEventListener('click', function (e) {
      if (e.target === lb || e.target.classList.contains('lightbox-close')) closeLb();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLb(); });
  }

  /* ---------- Promo hero auto-reel（首頁自動輪播） ---------- */
  (function () {
    var stage = document.getElementById('promo-stage');
    if (!stage) return;
    var scenes = stage.querySelectorAll('.promo-scene');
    var bars = document.querySelectorAll('#promo-progress .bar');
    var dotsWrap = document.getElementById('promo-dots');
    var badgeEl = document.querySelector('[data-promo="badge"]');
    var nameEl = document.querySelector('[data-promo="name"]');
    var tagEl = document.querySelector('[data-promo="tag"]');
    var chipsEl = document.querySelector('[data-promo="chips"]');
    var DUR = 5200;
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var data = [
      { badge: '夜間 · 鈣鎂營養', name: 'GABA 鈣鎂晶凍',
        tag: '睡前的放鬆儀式 × 日常鈣鎂營養補充 —— 純素、幾乎無糖、晶凍好入口。',
        chips: ['GABA', '鈣 150mg', '鎂 30mg', '維生素 D3・K2', '色胺酸・茶胺酸'] },
      { badge: '日間 · 營養補給', name: '左旋麩醯胺酸晶凍',
        tag: '忙碌日常與運動後的營養補給 —— 純素、晶凍好入口、免配水。',
        chips: ['左旋麩醯胺酸 1.5g', 'PUREWAY-C® 維生素C', '鋅 2.6mg', 'EGCG 綠茶萃取', '鳳梨酵素'] }
    ];
    var cur = 0, timer = null;

    data.forEach(function (d, i) {
      var b = document.createElement('button');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', d.name);
      b.addEventListener('click', function () { go(i); });
      dotsWrap.appendChild(b);
    });
    var dots = dotsWrap.querySelectorAll('button');

    function go(i) {
      cur = i;
      for (var s = 0; s < scenes.length; s++) scenes[s].classList.toggle('is-active', s === i);
      for (var d = 0; d < dots.length; d++) dots[d].classList.toggle('active', d === i);
      var info = data[i];
      if (badgeEl) badgeEl.textContent = info.badge;
      if (nameEl) nameEl.textContent = info.name;
      if (tagEl) tagEl.textContent = info.tag;
      if (chipsEl) {
        chipsEl.innerHTML = '';
        info.chips.forEach(function (c, ci) {
          var sp = document.createElement('span');
          sp.textContent = c;
          if (!reduce) {
            sp.style.animation = 'promo-pop .5s cubic-bezier(.16,1,.3,1) backwards';
            sp.style.animationDelay = (0.08 + ci * 0.07) + 's';
          }
          chipsEl.appendChild(sp);
        });
      }
      for (var k = 0; k < bars.length; k++) {
        bars[k].classList.remove('active', 'done');
        var fill = bars[k].querySelector('i');
        fill.style.animation = 'none'; void fill.offsetWidth; fill.style.animation = '';
        if (k < i) bars[k].classList.add('done');
      }
      if (bars[i]) {
        if (reduce) { bars[i].classList.add('done'); }
        else { bars[i].style.setProperty('--promo-dur', DUR + 'ms'); bars[i].classList.add('active'); }
      }
      if (timer) clearTimeout(timer);
      if (!reduce) timer = setTimeout(function () { go((cur + 1) % data.length); }, DUR);
    }
    go(0);
  })();

});
