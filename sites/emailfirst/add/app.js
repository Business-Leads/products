/* EmailFirst, add a lead. Felix's phone app (17 October 2026).
   Say or photograph, check the card, saved. It talks to /add/api/<op>,
   which the website passes to the EmailFirst sales system. Source of truth:
   business-leads-platform/ops/emailfirst-add/app.js */
(function () {
  'use strict';
  var root = document.getElementById('efa');
  var state = { said: '', photo: null, form: null, reason: '', existing: null, note: '', done: null };
  var KINDS = {
    '': 'Not sure, or none of these',
    'it-support': 'IT support', 'accountancy': 'Accountancy practice', 'engineering': 'Precision engineering subcontractor',
    'fractional-fd': 'Fractional finance director', 'cleaning': 'Cleaning or facilities', 'b2b-software': 'B2B software',
    'recruitment': 'Recruitment agency', 'marketing-agency': 'Marketing or web agency',
    'insurance-broker': 'Commercial insurance broker', 'training': 'Training company'
  };
  var HELP = {
    hot: 'Wants to start. Gets the payment link, a short form and your onboarding booking link straight away, then one reminder if needed.',
    warm: 'Interested, not decided. Three short emails over two and a half weeks, and a LinkedIn invitation.',
    cold: 'Just a card. A LinkedIn invitation and two light emails, about four weeks apart.'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function api(op, body) {
    return fetch('/add/api/' + op, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }
  function top() { window.scrollTo(0, 0); }
  function error(msg) { return msg ? '<p class="copy efa-note efa-error" role="alert">' + esc(msg) + '</p>' : ''; }

  function login(msg) {
    root.innerHTML =
      '<h1 class="display-m">Add a lead</h1>' +
      '<p class="lead efa-muted">Sign in once and this phone will remember you.</p>' +
      '<form class="efa-card" id="f">' +
      '<label class="copy-sm efa-label" for="e">Email</label><input class="efa-input" id="e" type="email" autocomplete="username" required>' +
      '<label class="copy-sm efa-label" for="p">Password</label><input class="efa-input" id="p" type="password" autocomplete="current-password" required>' +
      '<div style="margin-top: var(--space-20)">' + error(msg) + '</div>' +
      '<button class="ft-btn ft-btn--primary" type="submit" style="margin-top: var(--space-16)">Sign in</button>' +
      '<p class="copy-sm efa-muted" style="margin-top: var(--space-16)">Use the same email and password as your admin sign-in.</p>' +
      '</form>';
    document.getElementById('f').onsubmit = function (ev) {
      ev.preventDefault();
      api('login', { email: document.getElementById('e').value, password: document.getElementById('p').value })
        .then(function (r) { if (r.ok) input(); else login(r.error || 'Sign in did not work.'); })
        .catch(function () { login('Sign in did not work. Please check your signal.'); });
    };
    top();
  }

  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be opened.')); };
      img.src = url;
    });
  }

  function input(msg, busy) {
    root.innerHTML =
      '<h1 class="display-m">Who did you meet?</h1>' +
      '<label class="efa-sr" for="say">What you want to say about them</label>' +
      '<textarea class="efa-say" id="say" placeholder="Tap the microphone on your keyboard and say who they are, their email and phone, where you met, and how interested they were."' + (busy ? ' disabled' : '') + '>' + esc(state.said) + '</textarea>' +
      '<input id="file" type="file" accept="image/*" class="efa-sr" aria-label="Photograph a business card">' +
      (state.photo
        ? '<div class="efa-photo"><img src="' + state.photo + '" alt="The business card"><button type="button" class="efa-quiet" id="rm">Remove photo</button></div>'
        : '<button type="button" class="ft-btn ft-btn--secondary" id="cam" style="background: var(--canvas); border: 1px solid var(--line); color: var(--ink)">Photograph a business card</button>') +
      error(msg) +
      '<button type="button" class="ft-btn ft-btn--cta" id="next">' + (busy ? 'Reading...' : 'Next') + '</button>' +
      (busy ? '<p class="copy-sm efa-muted" style="text-align:center">This takes a few seconds.</p>' : '');
    var say = document.getElementById('say');
    var next = document.getElementById('next');
    function sync() { next.disabled = !!busy || (!say.value.trim() && !state.photo); }
    say.oninput = function () { state.said = say.value; sync(); };
    sync();
    var file = document.getElementById('file');
    var cam = document.getElementById('cam');
    if (cam) cam.onclick = function () { file.click(); };
    var rm = document.getElementById('rm');
    if (rm) rm.onclick = function () { state.photo = null; input(); };
    file.onchange = function () {
      var f = file.files && file.files[0];
      if (!f) return;
      shrink(f).then(function (d) { state.photo = d; input(); }).catch(function (e) { input(e.message); });
    };
    next.onclick = read;
  }

  function read() {
    input('', true);
    api('read', { text: state.said, image: state.photo }).then(function (r) {
      if (r.signedOut) return login('Please sign in again.');
      if (!r.ok || !r.contact) return input(r.error || 'That could not be read.');
      var c = r.contact;
      state.form = {
        firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, company: c.company, title: c.title,
        website: c.website, linkedinUrl: c.linkedinUrl, meeting: c.meeting, notes: c.notes, persona: c.persona,
        temperature: c.temperature, said: state.said
      };
      state.reason = c.temperatureReason || '';
      state.existing = r.existing || null;
      state.note = c.ok ? '' : (c.problem || '');
      confirmCard();
    }).catch(function () { input('Something went wrong reading that. Please check your signal and try again.'); });
  }

  function field(key, label, attrs) {
    return '<label class="copy-sm efa-label" for="k-' + key + '">' + label + '</label>' +
      '<input class="efa-input" id="k-' + key + '" data-k="' + key + '" value="' + esc(state.form[key]) + '" autocomplete="off" ' + (attrs || '') + '>';
  }

  function confirmCard(msg, busy) {
    var f = state.form;
    var ex = state.existing;
    var kinds = Object.keys(KINDS).map(function (k) {
      return '<option value="' + k + '"' + (f.persona === k ? ' selected' : '') + '>' + esc(KINDS[k]) + '</option>';
    }).join('');
    var temps = ['hot', 'warm', 'cold'].map(function (t) {
      return '<button type="button" role="radio" aria-checked="' + (f.temperature === t) + '" data-t="' + t + '" class="efa-temp' + (f.temperature === t ? ' is-' + t : '') + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</button>';
    }).join('');
    root.innerHTML =
      '<h1 class="display-m">Is this right?</h1>' +
      (state.note ? '<p class="copy efa-note">' + esc(state.note) + '</p>' : '') +
      (ex ? '<p class="copy efa-note">' + esc(ex.name) + ' is already in your list (added ' + esc(ex.added) + ', ' + esc(ex.stage) + '). ' +
        (ex.optedOut ? 'They asked not to be contacted, so saving only updates their details.' : 'Saving updates their details rather than adding them twice.') + '</p>' : '') +
      '<div class="efa-card">' +
      '<div class="efa-row2"><div>' + field('firstName', 'First name', 'autocapitalize="words"') + '</div><div>' + field('lastName', 'Last name', 'autocapitalize="words"') + '</div></div>' +
      field('email', 'Email', 'type="email" inputmode="email" autocapitalize="none"') +
      (f.email ? '' : '<p class="copy-sm" style="color: var(--coral-600); margin: 6px 0 0">No email address, so no emails can be sent. Add one if you have it.</p>') +
      field('phone', 'Phone', 'type="tel" inputmode="tel"') +
      field('company', 'Company', 'autocapitalize="words"') +
      field('title', 'Job title', 'autocapitalize="words"') +
      field('meeting', 'Where you met', 'placeholder="at the Chester networking breakfast"') +
      field('website', 'Website', 'inputmode="url" autocapitalize="none"') +
      field('linkedinUrl', 'LinkedIn (found for you if left empty)', 'inputmode="url" autocapitalize="none"') +
      '<label class="copy-sm efa-label" for="kind">Their kind of business</label><select class="efa-input" id="kind">' + kinds + '</select>' +
      '<label class="copy-sm efa-label" for="k-notes">Notes</label><textarea class="efa-input" id="k-notes" data-k="notes">' + esc(f.notes) + '</textarea>' +
      '</div>' +
      '<h2 class="card-title" style="margin: var(--space-8) 0 0">How warm is ' + esc(f.firstName || 'this person') + '?</h2>' +
      (state.reason ? '<p class="copy-sm efa-muted">You said &ldquo;' + esc(state.reason) + '&rdquo;.</p>' : '') +
      '<div class="efa-temps" role="radiogroup" aria-label="How warm">' + temps + '</div>' +
      '<p class="copy-sm efa-muted">' + esc(HELP[f.temperature]) + '</p>' +
      error(msg) +
      '<button type="button" class="ft-btn ft-btn--cta" id="save"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Saving...' : 'Save and start') + '</button>' +
      '<button type="button" class="efa-quiet" id="back">Back</button>';
    Array.prototype.forEach.call(root.querySelectorAll('[data-k]'), function (el) {
      el.oninput = function () { state.form[el.getAttribute('data-k')] = el.value; };
    });
    document.getElementById('kind').onchange = function (e) { state.form.persona = e.target.value; };
    Array.prototype.forEach.call(root.querySelectorAll('[data-t]'), function (el) {
      el.onclick = function () { state.form.temperature = el.getAttribute('data-t'); confirmCard(); };
    });
    document.getElementById('back').onclick = function () { input(); };
    document.getElementById('save').onclick = save;
  }

  function save() {
    confirmCard('', true);
    api('save', state.form).then(function (r) {
      if (r.signedOut) return login('Please sign in again. Nothing was saved.');
      if (!r.ok) return confirmCard(r.error || 'It did not save.');
      state.done = r;
      done();
    }).catch(function () { confirmCard('It did not save. Please check your signal and try again.'); });
  }

  function done(undone) {
    var r = state.done;
    root.innerHTML =
      '<div class="efa-done">' +
      '<span class="ft-tile ft-tile--violet" aria-hidden="true"><svg class="ft-icon" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>' +
      '<p class="card-title" role="status">' + esc(r.message) + '</p></div>' +
      '<button type="button" class="ft-btn ft-btn--cta" id="again">Add someone else</button>' +
      (r.canUndo && !undone ? '<button type="button" class="efa-quiet" id="undo">Undo, I added them by mistake</button>' : '') +
      (undone ? '<p class="copy efa-note" role="status">' + esc(undone) + '</p>' : '');
    document.getElementById('again').onclick = function () {
      state = { said: '', photo: null, form: null, reason: '', existing: null, note: '', done: null };
      input();
    };
    var u = document.getElementById('undo');
    if (u) u.onclick = function () {
      api('undo', { leadId: r.leadId }).then(function (x) {
        if (x.ok) r.canUndo = false;
        done(x.message);
      });
    };
    top();
  }

  api('session').then(function (s) { if (s.signedIn) input(); else login(); }).catch(function () { login(); });
})();
