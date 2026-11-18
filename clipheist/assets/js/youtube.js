/*
 * ClipHeist — direct YouTube upload (optional).
 * Uses Google Identity Services (token model) + YouTube Data API v3 resumable uploads.
 * Requires window.CLIPHEIST_CONFIG.youtubeClientId (see config.js / README).
 */
window.YTUpload = (function () {
  'use strict';
  var GIS_SRC = 'https://accounts.google.com/gsi/client';
  var SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
  var token = null;
  var tokenExpires = 0;
  var tokenClient = null;
  var gisPromise = null;

  function cfg() { return window.CLIPHEIST_CONFIG || {}; }
  function isConfigured() { return !!(cfg().youtubeClientId || '').trim(); }

  function loadGIS() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = GIS_SRC; s.async = true; s.defer = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { gisPromise = null; reject(new Error('Could not load Google sign-in. Check your connection or ad blocker.')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  /** Call early (e.g. when the export dialog opens) so the sign-in popup isn't blocked later. */
  function preload() { if (isConfigured()) loadGIS().catch(function () {}); }

  function getToken() {
    if (token && Date.now() < tokenExpires) return Promise.resolve(token);
    return loadGIS().then(function () {
      return new Promise(function (resolve, reject) {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: cfg().youtubeClientId.trim(),
          scope: SCOPE,
          callback: function (resp) {
            if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
            token = resp.access_token;
            tokenExpires = Date.now() + Math.max(60, (resp.expires_in || 3600) - 60) * 1000;
            resolve(token);
          },
          error_callback: function (err) {
            reject(new Error(err && err.type === 'popup_closed' ? 'Sign-in window was closed.' : (err && err.message) || 'Sign-in failed.'));
          }
        });
        tokenClient.requestAccessToken({ prompt: token ? '' : 'consent' });
      });
    });
  }

  function apiError(res) {
    return res.text().then(function (txt) {
      var msg = 'YouTube API error ' + res.status;
      try {
        var j = JSON.parse(txt);
        if (j.error && j.error.message) msg = j.error.message;
      } catch (e) { /* not json */ }
      throw new Error(msg);
    });
  }

  /**
   * @param {{blob: Blob, title: string, description: string, tags: string[], privacy: string, onProgress?: (p:number)=>void}} opts
   * @returns {Promise<{id: string, url: string}>}
   */
  function upload(opts) {
    var blob = opts.blob;
    return getToken().then(function (accessToken) {
      var meta = {
        snippet: {
          title: (opts.title || 'Gameplay clip').slice(0, 100),
          description: (opts.description || '').slice(0, 4900),
          tags: (opts.tags || []).slice(0, 30),
          categoryId: cfg().youtubeCategoryId || '20'
        },
        status: {
          privacyStatus: opts.privacy || 'private',
          selfDeclaredMadeForKids: false
        }
      };
      return fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(blob.size),
          'X-Upload-Content-Type': blob.type || 'video/*'
        },
        body: JSON.stringify(meta)
      }).then(function (res) {
        if (!res.ok) return apiError(res);
        var location = res.headers.get('Location');
        if (!location) throw new Error('YouTube did not return an upload URL.');
        return new Promise(function (resolve, reject) {
          var xhr = new XMLHttpRequest();
          xhr.open('PUT', location, true);
          xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
          xhr.setRequestHeader('Content-Type', blob.type || 'video/*');
          xhr.upload.onprogress = function (e) {
            if (e.lengthComputable && opts.onProgress) opts.onProgress(e.loaded / e.total);
          };
          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                var data = JSON.parse(xhr.responseText);
                resolve({ id: data.id, url: 'https://youtu.be/' + data.id });
              } catch (e) { reject(new Error('Upload finished but the response could not be read.')); }
            } else {
              var msg = 'Upload failed (' + xhr.status + ')';
              try { msg = JSON.parse(xhr.responseText).error.message || msg; } catch (e) { /* ignore */ }
              reject(new Error(msg));
            }
          };
          xhr.onerror = function () { reject(new Error('Network error during upload.')); };
          xhr.send(blob);
        });
      });
    });
  }

  return { isConfigured: isConfigured, preload: preload, upload: upload };
})();
