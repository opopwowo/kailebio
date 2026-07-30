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
});
