(function(){
  "use strict";

  /* ==========================================================
     PIXEL ART HELPERS
     ========================================================== */

  /* ==========================================================
     STATE
     ========================================================== */

  /* ==========================================================
     SUPABASE CONFIG
     ========================================================== */

  var SB_URL  = 'https://lhdkwgionggyqpmrjtbj.supabase.co';
  var SB_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxoZGt3Z2lvbmdneXFwbXJqdGJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyOTM5NzYsImV4cCI6MjA5Njg2OTk3Nn0.80VtZjk9c33yc4FmP10HjSMogE65jDKAqSqYM6oYwFM';
  var BUCKET  = 'skin-images';
  var AVATAR_BUCKET = 'avatars';

  /* anonymous session so we can mark "mine" skins (legacy, kept for old rows) */
  var SESSION_ID = (function(){
    var k = 'skinmc_session';
    var v = localStorage.getItem(k);
    if (!v){ v = 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2,9); localStorage.setItem(k, v); }
    return v;
  })();

  /* ---------- logged-in user (persisted) ---------- */
  var USER_KEY = 'skinmc_user';
  function loadUser(){
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch(e){ return null; }
  }
  function saveUser(user){
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  }

  function sbFetch(path, opts){
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    /* base headers always present */
    var headers = {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Accept': 'application/json'
    };
    /* Content-Type only on mutating requests — avoids CORS preflight on GET */
    if (method !== 'GET' && method !== 'HEAD'){
      headers['Content-Type'] = 'application/json';
    }
    /* merge any caller-supplied headers on top */
    Object.assign(headers, opts.headers || {});
    var finalOpts = Object.assign({}, opts, { headers: headers });
    return fetch(SB_URL + path, finalOpts);
  }
  function storageUrl(path){ return SB_URL + '/storage/v1/object/public/' + BUCKET + '/' + path; }
  function avatarStorageUrl(path){ return SB_URL + '/storage/v1/object/public/' + AVATAR_BUCKET + '/' + path; }

  /* a deterministic random pixel-art avatar based on username */
  function randomAvatarUrl(seed){
    return 'https://api.dicebear.com/9.x/pixel-art/png?size=128&seed=' + encodeURIComponent(seed + '-' + Date.now());
  }

  /* extra headers merged on top of sbFetch's defaults (e.g. Prefer: return=representation) */
  function sbHdr(extra){ return extra || {}; }

  function rpcErrorMessage(text){
    try {
      var parsed = JSON.parse(text);
      var msg = parsed.message || parsed.error || text;
      if (msg.indexOf('USERNAME_TAKEN') !== -1) return 'That username is already taken.';
      if (msg.indexOf('USERNAME_TOO_SHORT') !== -1) return 'Username must be at least 3 characters.';
      if (msg.indexOf('USERNAME_TOO_LONG') !== -1) return 'Username must be 20 characters or fewer.';
      if (msg.indexOf('USERNAME_INVALID') !== -1) return 'Username can only contain letters, numbers, and underscores.';
      if (msg.indexOf('PASSWORD_TOO_SHORT') !== -1) return 'Password must be at least 4 characters.';
      if (msg.indexOf('INVALID_LOGIN') !== -1) return 'Incorrect username or password.';
      if (msg.indexOf('AUTH_REQUIRED') !== -1) return 'Please sign in first.';
      return msg;
    } catch(e){
      return text || 'Something went wrong.';
    }
  }

  function rowToSkin(row){
    return {
      id:          row.id,
      name:        row.name,
      description: row.description || '',
      thumbType:   'image',
      thumb:       storageUrl(row.thumb_url),
      likes:       row.likes,
      dislikes:    row.dislikes,
      downloads:   row.downloads,
      liked:       false,
      disliked:    false,
      downloaded:  false,
      authorUsername: row.author_username || null,
      authorAvatar:   row.author_avatar || null,
      mine:        !!(state.user && row.user_id === state.user.id) || (!row.user_id && row.session_id === SESSION_ID),
      comments:    (row.comments || []).map(function(c){ return { author: c.author, text: c.text, authorAvatar: c.author_avatar || null, createdAt: c.created_at }; }),
      createdAt:   row.created_at
    };
  }

  /* ==========================================================
     STATE
     ========================================================== */

  var state = {
    skins: [],
    currentTab: 'home',
    detailSkinId: null,
    publishImage: null, // { dataUrl, width, height }
    user: loadUser(),   // { id, username, avatarUrl, token } | null
    signupAvatar: null, // { dataUrl } if user picked a custom avatar on sign up
    afterAuth: null     // optional callback to run once the user logs in/signs up
  };

  /* ==========================================================
     API LAYER  –  backed by Supabase
     ========================================================== */

  var api = {

    fetchFeed: function(){
      return sbFetch('/rest/v1/skins?select=*,comments(*)&order=created_at.desc')
      .then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function(rows){
        state.skins = rows.map(rowToSkin);
        return state.skins;
      });
    },

    /* fetch the current user's like/dislike/download state and merge it into state.skins */
    fetchMyState: function(){
      if (!state.user) return Promise.resolve();
      var token = state.user.token;
      return Promise.all([
        sbFetch('/rest/v1/rpc/get_my_reactions', { method: 'POST', body: JSON.stringify({ p_token: token }) })
          .then(function(r){ return r.ok ? r.json() : []; }),
        sbFetch('/rest/v1/rpc/get_my_downloads', { method: 'POST', body: JSON.stringify({ p_token: token }) })
          .then(function(r){ return r.ok ? r.json() : []; })
      ]).then(function(results){
        var reactions = results[0] || [];
        var downloads = results[1] || [];
        var rxBySkin = {};
        reactions.forEach(function(r){ rxBySkin[r.skin_id] = r; });
        var downloadedSet = {};
        downloads.forEach(function(d){ downloadedSet[d.skin_id] = true; });
        state.skins.forEach(function(skin){
          var rx = rxBySkin[skin.id];
          skin.liked = !!(rx && rx.liked);
          skin.disliked = !!(rx && rx.disliked);
          skin.downloaded = !!downloadedSet[skin.id];
        });
      });
    },

    /* ---------- AUTH ---------- */

    signup: function(username, password, avatarDataUrl){
      var avatarUrl = null;

      var avatarStep;
      if (avatarDataUrl){
        avatarStep = api.uploadAvatar(avatarDataUrl).then(function(url){ avatarUrl = url; });
      } else {
        avatarUrl = randomAvatarUrl(username);
        avatarStep = Promise.resolve();
      }

      return avatarStep.then(function(){
        return sbFetch('/rest/v1/rpc/app_signup', {
          method: 'POST',
          body: JSON.stringify({ p_username: username, p_password: password, p_avatar_url: avatarUrl })
        });
      }).then(function(r){
        return r.ok ? r.json() : r.text().then(function(t){ throw new Error(rpcErrorMessage(t)); });
      }).then(function(rows){
        var row = rows[0];
        var user = { id: row.user_id, username: row.username, avatarUrl: row.avatar_url, token: row.session_token };
        state.user = user;
        saveUser(user);
        return user;
      });
    },

    login: function(username, password){
      return sbFetch('/rest/v1/rpc/app_login', {
        method: 'POST',
        body: JSON.stringify({ p_username: username, p_password: password })
      }).then(function(r){
        return r.ok ? r.json() : r.text().then(function(t){ throw new Error(rpcErrorMessage(t)); });
      }).then(function(rows){
        var row = rows[0];
        var user = { id: row.user_id, username: row.username, avatarUrl: row.avatar_url, token: row.session_token };
        state.user = user;
        saveUser(user);
        return user;
      });
    },

    logout: function(){
      var token = state.user && state.user.token;
      state.user = null;
      saveUser(null);
      state.skins.forEach(function(skin){
        skin.liked = false;
        skin.disliked = false;
        skin.downloaded = false;
      });
      if (!token) return Promise.resolve();
      return sbFetch('/rest/v1/rpc/app_logout', {
        method: 'POST',
        body: JSON.stringify({ p_token: token })
      }).catch(function(){ /* ignore */ });
    },

    /* validates a stored session on page load; clears it if it's no longer valid */
    restoreSession: function(){
      if (!state.user || !state.user.token) return Promise.resolve();
      return sbFetch('/rest/v1/rpc/app_session_user', {
        method: 'POST',
        body: JSON.stringify({ p_token: state.user.token })
      }).then(function(r){ return r.ok ? r.json() : []; })
        .then(function(rows){
          if (!rows || !rows.length){
            state.user = null;
            saveUser(null);
          }
        }).catch(function(){ /* keep cached user if offline */ });
    },

    uploadAvatar: function(dataUrl){
      var filename = 'av_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.png';
      var b64 = dataUrl.split(',')[1];
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var blob = new Blob([bytes], { type: 'image/png' });

      return fetch(SB_URL + '/storage/v1/object/' + AVATAR_BUCKET + '/' + filename, {
        method: 'POST',
        headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'image/png', 'x-upsert': 'true' },
        body: blob
      })
      .then(function(r){ if (!r.ok) return r.text().then(function(t){ throw new Error('Avatar upload: ' + t); }); })
      .then(function(){ return avatarStorageUrl(filename); });
    },

    /* ---------- SKINS ---------- */

    publishSkin: function(skin){
      if (!state.user) return Promise.reject(new Error('AUTH_REQUIRED'));

      /* 1 – upload PNG to storage */
      var filename = SESSION_ID + '_' + Date.now() + '.png';
      var b64 = skin.thumb.split(',')[1];
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var blob = new Blob([bytes], { type: 'image/png' });

      return fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + filename, {
        method: 'POST',
        headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'image/png', 'x-upsert': 'true' },
        body: blob
      })
      .then(function(r){ if (!r.ok) return r.text().then(function(t){ throw new Error('Storage: ' + t); }); })

      /* 2 – insert skin row */
      .then(function(){
        return sbFetch('/rest/v1/skins', {
          method: 'POST',
          headers: sbHdr({ 'Prefer': 'return=representation' }),
          body: JSON.stringify({
            name: skin.name,
            description: skin.description,
            thumb_url: filename,
            session_id: SESSION_ID,
            user_id: state.user.id,
            author_username: state.user.username,
            author_avatar: state.user.avatarUrl
          })
        });
      })
      .then(function(r){ return r.ok ? r.json() : r.text().then(function(t){ throw new Error('Insert: ' + t); }); })
      .then(function(rows){
        var newSkin = rowToSkin(Object.assign({}, rows[0], { comments: [] }));
        state.skins.unshift(newSkin);
        return newSkin;
      });
    },

    setLike: function(skin, liked, disliked){
      if (!state.user) return Promise.reject(new Error('AUTH_REQUIRED'));
      return sbFetch('/rest/v1/rpc/set_reaction', {
        method: 'POST',
        body: JSON.stringify({ p_token: state.user.token, p_skin_id: skin.id, p_liked: liked, p_disliked: disliked })
      }).then(function(r){
        return r.ok ? r.json() : r.text().then(function(t){ throw new Error(rpcErrorMessage(t)); });
      }).then(function(rows){
        var row = rows[0];
        skin.likes = row.likes;
        skin.dislikes = row.dislikes;
        skin.liked = liked;
        skin.disliked = disliked;
        return skin;
      });
    },

    recordDownload: function(skin){
      if (!state.user) return Promise.reject(new Error('AUTH_REQUIRED'));
      return sbFetch('/rest/v1/rpc/increment_downloads', {
        method: 'POST',
        body: JSON.stringify({ p_token: state.user.token, p_skin_id: skin.id })
      }).then(function(r){
        if (!r.ok) return r.text().then(function(t){ throw new Error(rpcErrorMessage(t)); });
        return r.json();
      }).then(function(rows){
        var row = rows[0];
        skin.downloads = row.downloads;
        skin.downloaded = true;
        return skin;
      });
    },

    addComment: function(skin, text){
      var author = state.user ? state.user.username : 'Anonymous';
      var authorAvatar = state.user ? state.user.avatarUrl : null;
      return sbFetch('/rest/v1/comments', {
        method: 'POST',
        headers: sbHdr({ 'Prefer': 'return=representation' }),
        body: JSON.stringify({ skin_id: skin.id, author: author, author_avatar: authorAvatar, user_id: state.user ? state.user.id : null, text: text })
      })
      .then(function(r){ return r.ok ? r.json() : r.text().then(function(t){ throw new Error(t); }); })
      .then(function(rows){
        var comment = { author: rows[0].author, text: rows[0].text, authorAvatar: rows[0].author_avatar || null, createdAt: rows[0].created_at };
        skin.comments.push(comment);
        return comment;
      });
    }
  };

  /* ==========================================================
     DOM REFS
     ========================================================== */

  var $ = function(id){ return document.getElementById(id); };

  var views = {
    home: $('view-home'),
    search: $('view-search'),
    publish: $('view-publish')
  };
  var navButtons = document.querySelectorAll('.navbtn');
  var topbarSub = $('topbar-sub');

  var homeFeedEl = $('home-feed');
  var homeCountEl = $('home-count');
  var homeEmptyEl = $('home-empty');
  var heroSkinsCountEl = $('hero-skins-count');
  var heroDownloadsCountEl = $('hero-downloads-count');

  var searchInput = $('search-input');
  var searchPrompt = $('search-prompt');
  var searchEmpty = $('search-empty');
  var searchResults = $('search-results');

  var publishForm = $('publish-form');
  var publishAuthGate = $('publish-auth-gate');
  var publishAuthBtn = $('publish-auth-btn');
  var nameInput = $('skin-name-input');
  var descInput = $('skin-desc-input');
  var fileInput = $('skin-file-input');
  var uploadBox = $('upload-box');
  var uploadPreview = $('upload-preview');
  var uploadPreviewImg = $('upload-preview-img');
  var uploadHint = $('upload-hint');
  var uploadError = $('upload-error');
  var publishSubmitBtn = $('publish-submit-btn');
  var resetPublishBtn = $('reset-publish-btn');

  var overlay = $('detail-overlay');
  var detailCloseBtn = $('detail-close-btn');
  var detailThumb = $('detail-thumb');
  var detailName = $('detail-name');
  var detailDesc = $('detail-desc');
  var likeBtn = $('like-btn');
  var dislikeBtn = $('dislike-btn');
  var likeCount = $('like-count');
  var dislikeCount = $('dislike-count');
  var downloadCount = $('download-count');
  var downloadBtn = $('download-btn');
  var commentsList = $('comments-list');
  var commentCountLabel = $('comment-count-label');
  var commentInput = $('comment-input');
  var commentSubmitBtn = $('comment-submit-btn');

  var toastEl = $('toast');
  var toastTopEl = $('toast-top');
  var toastTopTextEl = $('toast-top-text');

  /* ---------- Account / Auth ---------- */
  var accountBtn = $('account-btn');
  var accountAvatarImg = $('account-avatar-img');
  var accountIconDefault = $('account-icon-default');
  var authOverlay = $('auth-overlay');
  var authCloseBtn = $('auth-close-btn');
  var authLoggedOut = $('auth-logged-out');
  var authLoggedIn = $('auth-logged-in');
  var authTabs = document.querySelectorAll('.auth-tab');
  var signinForm = $('signin-form');
  var signinUsername = $('signin-username');
  var signinPassword = $('signin-password');
  var signinError = $('signin-error');
  var signinSubmitBtn = $('signin-submit-btn');
  var signupForm = $('signup-form');
  var signupUsername = $('signup-username');
  var signupPassword = $('signup-password');
  var signupAvatarInput = $('signup-avatar-input');
  var signupAvatarPreview = $('signup-avatar-preview');
  var signupAvatarPreviewImg = $('signup-avatar-preview-img');
  var signupError = $('signup-error');
  var signupSubmitBtn = $('signup-submit-btn');
  var accountMenuAvatar = $('account-menu-avatar');
  var accountMenuAvatarImg = $('account-menu-avatar-img');
  var accountMenuName = $('account-menu-name');
  var logoutBtn = $('logout-btn');

  /* ==========================================================
     RENDER HELPERS
     ========================================================== */

  function renderThumb(container, skin){
    container.innerHTML = '';
    if (skin.thumbType === 'svg'){
      container.innerHTML = skin.thumb;
    } else {
      var img = document.createElement('img');
      img.src = skin.thumb;
      img.alt = skin.name + ' skin preview';
      container.appendChild(img);
    }
  }

  function frontDraw(dp, dpM, nf){
    dp(8,8,8,8,4,0);      /* head front */
    dp(40,8,8,8,4,0);     /* hat overlay */
    dp(20,20,8,12,4,8);   /* body front */
    dp(44,20,4,12,0,8);   /* R arm (player-right = viewer-left) */
    if(nf){ dp(36,52,4,12,12,8); }else{ dpM(44,20,4,12,12,8); }  /* L arm */
    dp(4,20,4,12,4,20);   /* R leg */
    if(nf){ dp(20,52,4,12,8,20); }else{ dpM(4,20,4,12,8,20); }   /* L leg */
  }

  function backDraw(dp, dpM, nf){
    dpM(24,8,8,8,4,0);    /* head back */
    dpM(56,8,8,8,4,0);    /* hat back */
    dpM(32,20,8,12,4,8);  /* body back */
    dpM(52,20,4,12,12,8); /* R arm back (viewer-right) */
    if(nf){ dpM(44,52,4,12,0,8); }else{ dp(52,20,4,12,0,8); }    /* L arm back */
    dpM(12,20,4,12,8,20); /* R leg back (viewer-right) */
    if(nf){ dpM(28,52,4,12,4,20); }else{ dp(12,20,4,12,4,20); }  /* L leg back */
  }

  /* Renders just the FRONT 2D view onto a single canvas, used for feed/search/card thumbnails */
  function renderSkinFront(container, skin){
    container.innerHTML = '';
    if (skin.thumbType === 'svg' || !skin.thumb){ renderThumb(container, skin); return; }
    var img = new Image();
    img.onload = function(){
      var scale = 4;
      var f = img.width / 64;
      var newFmt = (img.height / img.width) >= 1;
      var canvas = document.createElement('canvas');
      canvas.width = 16 * scale;
      canvas.height = 32 * scale;
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      function dp(sx,sy,sw,sh,dx,dy){ ctx.drawImage(img,sx*f,sy*f,sw*f,sh*f,dx*scale,dy*scale,sw*scale,sh*scale); }
      function dpM(sx,sy,sw,sh,dx,dy){ ctx.save(); ctx.translate((dx+sw)*scale,dy*scale); ctx.scale(-1,1); ctx.drawImage(img,sx*f,sy*f,sw*f,sh*f,0,0,sw*scale,sh*scale); ctx.restore(); }
      frontDraw(dp, dpM, newFmt);
      container.appendChild(canvas);
    };
    img.onerror = function(){ renderThumb(container, skin); };
    img.src = skin.thumb;
  }

  function renderSkin2D(container, skin){
    container.innerHTML = '';
    if (skin.thumbType === 'svg' || !skin.thumb){ renderThumb(container, skin); return; }
    var img = new Image();
    img.onload = function(){
      var scale = 6;
      var f = img.width / 64;
      var newFmt = (img.height / img.width) >= 1;
      var wrap = document.createElement('div');
      wrap.className = 'skin-2d-wrap';
      function makeCanvas(labelText, drawFn){
        var vwrap = document.createElement('div');
        vwrap.className = 'skin-2d-view';
        var lbl = document.createElement('div');
        lbl.className = 'skin-2d-label';
        lbl.textContent = labelText;
        var canvas = document.createElement('canvas');
        canvas.width = 16 * scale;
        canvas.height = 32 * scale;
        canvas.style.cssText = 'image-rendering:pixelated;image-rendering:crisp-edges;display:block;';
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        function dp(sx,sy,sw,sh,dx,dy){ ctx.drawImage(img,sx*f,sy*f,sw*f,sh*f,dx*scale,dy*scale,sw*scale,sh*scale); }
        function dpM(sx,sy,sw,sh,dx,dy){ ctx.save(); ctx.translate((dx+sw)*scale,dy*scale); ctx.scale(-1,1); ctx.drawImage(img,sx*f,sy*f,sw*f,sh*f,0,0,sw*scale,sh*scale); ctx.restore(); }
        drawFn(dp, dpM, newFmt);
        vwrap.appendChild(lbl);
        vwrap.appendChild(canvas);
        return vwrap;
      }
      /* FRONT */
      wrap.appendChild(makeCanvas('FRONT', frontDraw));
      /* BACK — back faces mirrored; in back view R=viewer-right, L=viewer-left */
      wrap.appendChild(makeCanvas('BACK', backDraw));
      container.appendChild(wrap);
    };
    img.onerror = function(){ renderThumb(container, skin); };
    img.src = skin.thumb;
  }

  var ICON_DOWNLOAD = '<svg viewBox="0 0 8 8" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">' +
    '<rect class="icon-fill" x="3" y="0" width="2" height="4"/>' +
    '<rect class="icon-fill" x="1" y="3" width="6" height="1"/>' +
    '<rect class="icon-fill" x="2" y="4" width="4" height="1"/>' +
    '<rect class="icon-fill" x="3" y="5" width="2" height="1"/>' +
    '<rect class="icon-fill" x="0" y="7" width="8" height="1"/>' +
    '</svg>';

  var ICON_LIKE = '<svg viewBox="0 0 8 8" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">' +
    '<rect class="icon-fill" x="3" y="1" width="2" height="1"/>' +
    '<rect class="icon-fill" x="2" y="2" width="4" height="1"/>' +
    '<rect class="icon-fill" x="1" y="3" width="6" height="1"/>' +
    '<rect class="icon-fill" x="3" y="4" width="2" height="3"/>' +
    '</svg>';

  var ICON_DISLIKE = '<svg viewBox="0 0 8 8" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">' +
    '<rect class="icon-fill" x="3" y="6" width="2" height="1"/>' +
    '<rect class="icon-fill" x="2" y="5" width="4" height="1"/>' +
    '<rect class="icon-fill" x="1" y="4" width="6" height="1"/>' +
    '<rect class="icon-fill" x="3" y="1" width="2" height="3"/>' +
    '</svg>';

  function createCardStats(skin){
    var stats = document.createElement('div');
    stats.className = 'skin-card-stats';

    var dl = document.createElement('span');
    dl.className = 'stat download';
    dl.innerHTML = ICON_DOWNLOAD + '<span>' + skin.downloads + '</span>';
    stats.appendChild(dl);

    var like = document.createElement('span');
    like.className = 'stat like';
    like.innerHTML = ICON_LIKE + '<span>' + skin.likes + '</span>';
    stats.appendChild(like);

    var dislike = document.createElement('span');
    dislike.className = 'stat dislike';
    dislike.innerHTML = ICON_DISLIKE + '<span>' + skin.dislikes + '</span>';
    stats.appendChild(dislike);

    return stats;
  }

  function createCard(skin){
    var card = document.createElement('div');
    card.className = 'skin-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('data-skin-id', skin.id);

    var thumb = document.createElement('div');
    thumb.className = 'skin-thumb';
    renderSkinFront(thumb, skin);
    card.appendChild(thumb);

    var nameEl = document.createElement('div');
    nameEl.className = 'skin-card-name';
    nameEl.textContent = skin.name;
    card.appendChild(nameEl);

    if (skin.mine){
      var badge = document.createElement('div');
      badge.className = 'skin-card-badge';
      badge.textContent = 'YOURS';
      card.appendChild(badge);
    }

    card.appendChild(createCardStats(skin));

    card.addEventListener('click', function(){ openDetail(skin.id); });
    card.addEventListener('keydown', function(e){
      if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); openDetail(skin.id); }
    });

    return card;
  }

  function renderGrid(container, skins){
    container.innerHTML = '';
    skins.forEach(function(skin){ container.appendChild(createCard(skin)); });
  }

  /* ---------- Home ---------- */
  function renderHome(){
    homeCountEl.textContent = '(' + state.skins.length + ')';

    var totalDownloads = state.skins.reduce(function(sum, s){ return sum + (s.downloads || 0); }, 0);
    heroSkinsCountEl.textContent = state.skins.length;
    heroDownloadsCountEl.textContent = totalDownloads;

    if (state.skins.length === 0){
      homeEmptyEl.classList.remove('hidden');
      homeFeedEl.classList.add('hidden');
      homeFeedEl.innerHTML = '';
    } else {
      homeEmptyEl.classList.add('hidden');
      homeFeedEl.classList.remove('hidden');
      renderGrid(homeFeedEl, state.skins);
    }
  }

  /* ---------- Search ---------- */
  function renderSearch(){
    var query = searchInput.value.trim().toLowerCase();
    if (!query){
      searchPrompt.classList.remove('hidden');
      searchEmpty.classList.add('hidden');
      searchResults.classList.add('hidden');
      return;
    }
    var matches = state.skins.filter(function(s){
      return s.name.toLowerCase().indexOf(query) !== -1;
    });
    searchPrompt.classList.add('hidden');
    if (matches.length === 0){
      searchEmpty.classList.remove('hidden');
      searchResults.classList.add('hidden');
    } else {
      searchEmpty.classList.add('hidden');
      searchResults.classList.remove('hidden');
      renderGrid(searchResults, matches);
    }
  }

  /* ==========================================================
     TAB NAVIGATION
     ========================================================== */

  var topbarLabels = { home: 'Explore', search: 'Search', publish: 'Publish' };

  function switchTab(tab){
    state.currentTab = tab;
    Object.keys(views).forEach(function(key){
      views[key].classList.toggle('active', key === tab);
    });
    navButtons.forEach(function(btn){
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
    });
    topbarSub.textContent = topbarLabels[tab] || '';

    if (tab === 'home') renderHome();
    if (tab === 'search') renderSearch();
    if (tab === 'publish') updatePublishGate();

    window.scrollTo(0, 0);
  }

  function updatePublishGate(){
    var loggedIn = !!state.user;
    publishAuthGate.classList.toggle('hidden', loggedIn);
    publishForm.classList.toggle('hidden', !loggedIn);
  }

  navButtons.forEach(function(btn){
    btn.addEventListener('click', function(){
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  /* ==========================================================
     DETAIL OVERLAY
     ========================================================== */

  function findSkin(id){
    for (var i = 0; i < state.skins.length; i++){
      if (state.skins[i].id === id) return state.skins[i];
    }
    return null;
  }

  function openDetail(id){
    state.detailSkinId = id;
    var skin = findSkin(id);
    if (!skin) return;

    renderSkin2D(detailThumb, skin);
    detailName.textContent = skin.name;
    detailDesc.textContent = skin.description && skin.description.trim()
      ? skin.description
      : 'No description provided.';

    updateDetailStats(skin);
    renderComments(skin);
    commentInput.value = '';

    overlay.classList.add('open');
    overlay.scrollTop = 0;
  }

  function closeDetail(){
    overlay.classList.remove('open');
    state.detailSkinId = null;
  }

  var downloadBtnLabel = $('download-btn-label');

  function updateDetailStats(skin){
    likeCount.textContent = skin.likes;
    dislikeCount.textContent = skin.dislikes;
    downloadCount.textContent = skin.downloads;
    likeBtn.classList.toggle('active-like', skin.liked);
    dislikeBtn.classList.toggle('active-dislike', skin.disliked);
    downloadBtnLabel.textContent = skin.downloaded ? 'DOWNLOADED ✓' : 'DOWNLOAD';
  }

  function renderComments(skin){
    commentsList.innerHTML = '';
    commentCountLabel.textContent = '(' + skin.comments.length + ')';
    if (skin.comments.length === 0){
      var empty = document.createElement('p');
      empty.className = 'empty-msg';
      empty.style.padding = '16px 0';
      empty.textContent = 'No comments yet. Be the first!';
      commentsList.appendChild(empty);
      return;
    }
    skin.comments.forEach(function(c){
      var item = document.createElement('div');
      item.className = 'comment';

      var author = document.createElement('div');
      author.className = 'comment-author';
      author.textContent = c.author;
      item.appendChild(author);

      var text = document.createElement('div');
      text.className = 'comment-text';
      text.textContent = c.text;
      item.appendChild(text);

      commentsList.appendChild(item);
    });
  }

  detailCloseBtn.addEventListener('click', closeDetail);

  likeBtn.addEventListener('click', function(){
    var skin = findSkin(state.detailSkinId);
    if (!skin) return;
    if (!state.user){
      openAuthModal('Sign in to like skins.', function(){ likeBtn.click(); });
      return;
    }
    var liked, disliked, likes = skin.likes, dislikes = skin.dislikes;
    if (skin.liked){
      liked = false; disliked = skin.disliked;
      likes -= 1;
    } else {
      if (skin.disliked) dislikes -= 1;
      liked = true; disliked = false;
      likes += 1;
    }
    skin.likes = likes;
    skin.dislikes = dislikes;
    api.setLike(skin, liked, disliked).then(function(){
      updateDetailStats(skin);
    });
  });

  dislikeBtn.addEventListener('click', function(){
    var skin = findSkin(state.detailSkinId);
    if (!skin) return;
    if (!state.user){
      openAuthModal('Sign in to dislike skins.', function(){ dislikeBtn.click(); });
      return;
    }
    var liked, disliked, likes = skin.likes, dislikes = skin.dislikes;
    if (skin.disliked){
      disliked = false; liked = skin.liked;
      dislikes -= 1;
    } else {
      if (skin.liked) likes -= 1;
      disliked = true; liked = false;
      dislikes += 1;
    }
    skin.likes = likes;
    skin.dislikes = dislikes;
    api.setLike(skin, liked, disliked).then(function(){
      updateDetailStats(skin);
    });
  });

  downloadBtn.addEventListener('click', function(){
    var skin = findSkin(state.detailSkinId);
    if (!skin) return;
    if (!state.user){
      openAuthModal('Sign in to download skins.', function(){ downloadBtn.click(); });
      return;
    }

    var filename = sanitizeFilename(skin.name);

    showTopToast('Your skin is downloading...');

    if (skin.thumbType === 'svg'){
      var blob = new Blob([skin.thumb], { type: 'image/svg+xml' });
      var svgUrl = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = svgUrl; a.download = filename + '.svg';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(svgUrl);
      api.recordDownload(skin).then(function(){
        refreshDownloadDisplays(skin);
      }).catch(function(err){
        refreshDownloadDisplays(skin);
        console.error(err);
      }).then(function(){
        hideTopToast();
      });
    } else {
      /* fetch as blob so the download attribute works cross-origin */
      fetch(skin.thumb)
        .then(function(r){ return r.blob(); })
        .then(function(blob){
          var blobUrl = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = blobUrl; a.download = filename + '.png';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function(){ URL.revokeObjectURL(blobUrl); }, 2000);
          return api.recordDownload(skin);
        })
        .then(function(){
          refreshDownloadDisplays(skin);
        })
        .catch(function(err){
          console.error(err);
          refreshDownloadDisplays(skin);
          showToast('Download failed.');
        })
        .then(function(){
          hideTopToast();
        });
    }
  });

  /* keep the detail view, feed cards, and hero stats in sync after a download */
  function refreshDownloadDisplays(skin){
    updateDetailStats(skin);

    var cardSpans = document.querySelectorAll('.skin-card[data-skin-id="' + skin.id + '"] .stat.download span');
    cardSpans.forEach(function(span){ span.textContent = skin.downloads; });

    var totalDownloads = state.skins.reduce(function(sum, s){ return sum + (s.downloads || 0); }, 0);
    heroDownloadsCountEl.textContent = totalDownloads;
  }

  commentSubmitBtn.addEventListener('click', submitComment);
  commentInput.addEventListener('keydown', function(e){
    if (e.key === 'Enter'){ e.preventDefault(); submitComment(); }
  });

  function submitComment(){
    var skin = findSkin(state.detailSkinId);
    if (!skin) return;
    var text = commentInput.value.trim();
    if (!text) return;
    api.addComment(skin, text).then(function(){
      commentInput.value = '';
      renderComments(skin);
    });
  }

  function sanitizeFilename(name){
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'skin';
  }

  /* ==========================================================
     SEARCH INPUT
     ========================================================== */

  searchInput.addEventListener('input', renderSearch);

  /* ==========================================================
     PUBLISH FLOW
     ========================================================== */

  resetPublishBtn.addEventListener('click', resetPublishForm);

  function resetPublishForm(){
    publishForm.reset();
    state.publishImage = null;
    uploadBox.classList.remove('has-image');
    uploadPreview.classList.add('hidden-preview');
    uploadPreviewImg.src = '';
    uploadHint.textContent = 'No file selected.';
    uploadHint.classList.remove('hidden');
    uploadError.classList.add('hidden');
    uploadError.textContent = '';
    updatePublishButtonState();
  }

  function updatePublishButtonState(){
    var nameOk = nameInput.value.trim().length > 0;
    publishSubmitBtn.disabled = !(nameOk && state.publishImage);
  }

  nameInput.addEventListener('input', updatePublishButtonState);

  fileInput.addEventListener('change', function(e){
    var file = e.target.files && e.target.files[0];

    state.publishImage = null;
    uploadBox.classList.remove('has-image');
    uploadPreview.classList.add('hidden-preview');
    uploadError.classList.add('hidden');
    uploadHint.classList.remove('hidden');

    if (!file){
      uploadHint.textContent = 'No file selected.';
      updatePublishButtonState();
      return;
    }

    if (file.type !== 'image/png'){
      showUploadError('That file is not a PNG. Please choose a .png image.');
      updatePublishButtonState();
      return;
    }

    var reader = new FileReader();
    reader.onload = function(ev){
      var dataUrl = ev.target.result;
      var img = new Image();
      img.onload = function(){
        var w = img.naturalWidth, h = img.naturalHeight;
        var validDims = (w === 64 && h === 64) || (w === 64 && h === 32) || (w === 128 && h === 128) || (w === 128 && h === 64);
        if (!validDims){
          showUploadError('Image must be 64\u00D764, 64\u00D732, 128\u00D7128, or 128\u00D764 pixels. Yours is ' + w + '\u00D7' + h + '.');
          state.publishImage = null;
          updatePublishButtonState();
          return;
        }
        state.publishImage = { dataUrl: dataUrl, width: w, height: h };
        uploadPreviewImg.src = dataUrl;
        uploadPreview.classList.remove('hidden-preview');
        uploadBox.classList.add('has-image');
        uploadHint.textContent = file.name + ' \u2014 ' + w + '\u00D7' + h + ' OK';
        uploadHint.classList.remove('hidden');
        uploadError.classList.add('hidden');
        updatePublishButtonState();
      };
      img.onerror = function(){
        showUploadError('Could not read this image file.');
        updatePublishButtonState();
      };
      img.src = dataUrl;
    };
    reader.onerror = function(){
      showUploadError('Could not read this file.');
      updatePublishButtonState();
    };
    reader.readAsDataURL(file);
  });

  function showUploadError(msg){
    uploadError.textContent = msg;
    uploadError.classList.remove('hidden');
    uploadHint.classList.add('hidden');
    uploadPreview.classList.add('hidden-preview');
    uploadBox.classList.remove('has-image');
  }

  publishForm.addEventListener('submit', function(e){
    e.preventDefault();
    var name = nameInput.value.trim();
    if (!name || !state.publishImage) return;
    if (!state.user){
      openAuthModal('Sign in to publish your skin.');
      return;
    }

    publishSubmitBtn.disabled = true;
    publishSubmitBtn.textContent = 'UPLOADING…';
    showTopToast('Publishing your skin...');

    var newSkin = {
      name: name,
      description: descInput.value.trim(),
      thumbType: 'image',
      thumb: state.publishImage.dataUrl
    };

    api.publishSkin(newSkin).then(function(savedSkin){
      publishSubmitBtn.textContent = 'PUBLISH';
      resetPublishForm();
      switchTab('home');
      hideTopToast();
      showToast('Successfully published! Tap to view.', function(){
        openDetail(savedSkin.id);
      });
    }).catch(function(err){
      publishSubmitBtn.disabled = false;
      publishSubmitBtn.textContent = 'PUBLISH';
      hideTopToast();
      showToast('Upload failed. Try again.');
      console.error(err);
    });
  });

  /* ==========================================================
     TOAST
     ========================================================== */

  var toastTimer = null;
  function showToast(message, onTap){
    toastEl.textContent = message;
    toastEl.classList.add('show');
    toastEl.classList.toggle('tappable', !!onTap);
    toastEl.onclick = onTap ? function(){
      toastEl.classList.remove('show');
      if (toastTimer) clearTimeout(toastTimer);
      onTap();
    } : null;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){
      toastEl.classList.remove('show');
    }, onTap ? 4000 : 2200);
  }

  var topToastTimer = null;
  function showTopToast(message){
    toastTopTextEl.textContent = message;
    toastTopEl.classList.add('show');
    if (topToastTimer){ clearTimeout(topToastTimer); topToastTimer = null; }
  }
  function hideTopToast(){
    if (topToastTimer) clearTimeout(topToastTimer);
    topToastTimer = setTimeout(function(){
      toastTopEl.classList.remove('show');
    }, 600);
  }

  /* ==========================================================
     ACCOUNT / AUTH MODAL
     ========================================================== */

  var authModalMessage = $('auth-modal-message');

  function updateAccountButton(){
    var loggedIn = !!state.user;
    accountBtn.classList.toggle('logged-in', loggedIn);
    if (loggedIn && state.user.avatarUrl){
      accountAvatarImg.src = state.user.avatarUrl;
      accountAvatarImg.classList.remove('hidden');
      accountIconDefault.classList.add('hidden');
    } else {
      accountAvatarImg.classList.add('hidden');
      accountIconDefault.classList.remove('hidden');
    }
  }

  function openAuthModal(message, afterAuthCb){
    state.afterAuth = afterAuthCb || null;

    if (state.user){
      authLoggedOut.classList.add('hidden');
      authLoggedIn.classList.remove('hidden');
      accountMenuName.textContent = state.user.username;
      if (state.user.avatarUrl){
        accountMenuAvatarImg.src = state.user.avatarUrl;
        accountMenuAvatarImg.classList.remove('hidden');
      } else {
        accountMenuAvatarImg.classList.add('hidden');
      }
    } else {
      authLoggedOut.classList.remove('hidden');
      authLoggedIn.classList.add('hidden');
      if (message){
        authModalMessage.textContent = message;
        authModalMessage.classList.remove('hidden');
      } else {
        authModalMessage.classList.add('hidden');
      }
      switchAuthTab('signin');
      signinError.textContent = '';
      signupError.textContent = '';
    }

    authOverlay.classList.add('open');
    authOverlay.scrollTop = 0;
  }

  function closeAuthModal(){
    authOverlay.classList.remove('open');
    state.afterAuth = null;
  }

  var authHeaderTitle = $('auth-header-title');
  var authHeaderSub = $('auth-header-sub');

  function switchAuthTab(tab){
    authTabs.forEach(function(btn){
      btn.classList.toggle('active', btn.getAttribute('data-auth-tab') === tab);
    });
    signinForm.classList.toggle('active', tab === 'signin');
    signupForm.classList.toggle('active', tab === 'signup');
    if (tab === 'signup'){
      authHeaderTitle.textContent = 'CREATE AN ACCOUNT';
      authHeaderSub.textContent = 'Pick a username and password to get started';
    } else {
      authHeaderTitle.textContent = 'WELCOME BACK';
      authHeaderSub.textContent = 'Sign in to like, download & publish skins';
    }
  }

  accountBtn.addEventListener('click', function(){ openAuthModal(); });
  authCloseBtn.addEventListener('click', closeAuthModal);

  document.querySelectorAll('[data-auth-tab]').forEach(function(btn){
    btn.addEventListener('click', function(){
      switchAuthTab(btn.getAttribute('data-auth-tab'));
      signinError.textContent = '';
      signupError.textContent = '';
    });
  });

  /* show/hide password */
  document.querySelectorAll('.pw-toggle').forEach(function(btn){
    btn.addEventListener('click', function(){
      var target = $(btn.getAttribute('data-pw-target'));
      var hidden = target.type === 'password';
      target.type = hidden ? 'text' : 'password';
      btn.textContent = hidden ? 'HIDE' : 'SHOW';
    });
  });

  /* avatar picker on sign up */
  signupAvatarInput.addEventListener('change', function(){
    var file = signupAvatarInput.files && signupAvatarInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(e){
      state.signupAvatar = e.target.result;
      signupAvatarPreviewImg.src = e.target.result;
      signupAvatarPreviewImg.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  });

  /* run once after a successful sign in / sign up */
  function onAuthSuccess(){
    closeAuthModal();
    updateAccountButton();

    var cb = state.afterAuth;
    state.afterAuth = null;

    api.fetchMyState().then(function(){
      var skin = findSkin(state.detailSkinId);
      if (skin && overlay.classList.contains('open')) updateDetailStats(skin);
      if (state.currentTab === 'publish') updatePublishGate();
      if (cb) cb();
    });
  }

  signinForm.addEventListener('submit', function(e){
    e.preventDefault();
    var username = signinUsername.value.trim();
    var password = signinPassword.value;
    if (!username || !password) return;

    signinError.textContent = '';
    signinSubmitBtn.disabled = true;
    signinSubmitBtn.textContent = 'SIGNING IN…';

    api.login(username, password).then(function(){
      signinSubmitBtn.disabled = false;
      signinSubmitBtn.textContent = 'SIGN IN';
      signinForm.reset();
      onAuthSuccess();
    }).catch(function(err){
      signinSubmitBtn.disabled = false;
      signinSubmitBtn.textContent = 'SIGN IN';
      signinError.textContent = err.message || 'Could not sign in.';
    });
  });

  signupForm.addEventListener('submit', function(e){
    e.preventDefault();
    var username = signupUsername.value.trim();
    var password = signupPassword.value;
    if (!username || !password) return;

    signupError.textContent = '';
    signupSubmitBtn.disabled = true;
    signupSubmitBtn.textContent = 'SIGNING UP…';

    api.signup(username, password, state.signupAvatar).then(function(){
      signupSubmitBtn.disabled = false;
      signupSubmitBtn.textContent = 'SIGN UP';
      signupForm.reset();
      state.signupAvatar = null;
      signupAvatarPreviewImg.classList.add('hidden');
      onAuthSuccess();
    }).catch(function(err){
      signupSubmitBtn.disabled = false;
      signupSubmitBtn.textContent = 'SIGN UP';
      signupError.textContent = err.message || 'Could not sign up.';
    });
  });

  logoutBtn.addEventListener('click', function(){
    api.logout().then(function(){
      updateAccountButton();
      closeAuthModal();

      var skin = findSkin(state.detailSkinId);
      if (skin && overlay.classList.contains('open')) updateDetailStats(skin);
      if (state.currentTab === 'publish') updatePublishGate();
      showToast('Signed out.');
    });
  });

  publishAuthBtn.addEventListener('click', function(){
    openAuthModal('Sign in or sign up to publish a skin.');
  });

  /* ==========================================================
     INIT
     ========================================================== */

  function init(){
    updateAccountButton();

    /* show loading state */
    homeEmptyEl.classList.add('hidden');
    homeFeedEl.classList.add('hidden');
    homeFeedEl.innerHTML = '<p class="empty-msg" style="padding:40px 12px;">Loading skins…</p>';
    homeFeedEl.classList.remove('hidden');

    switchTab('home');

    api.restoreSession().then(function(){
      updateAccountButton();
      return api.fetchFeed();
    }).then(function(){
      return api.fetchMyState();
    }).then(function(){
      renderHome();
    }).catch(function(err){
      homeFeedEl.innerHTML = '<p class="empty-msg" style="padding:40px 12px;color:var(--red);">Could not load skins. Check your connection.</p>';
      console.error('fetchFeed error:', err);
    });
  }

  init();

})();
