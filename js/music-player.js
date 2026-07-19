;(function () {
  'use strict'

  // 1. 常量 & 枚举
  var State = { IDLE: 'idle', LOADING: 'loading', PLAYING: 'playing', PAUSED: 'paused', ERROR: 'error' }
  var PLAYLIST_URL = '/music/playlist.json'
  var STORAGE_KEY = 'music_player_state'

  // 2. 工具函数
  function formatTime (seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00'
    var m = Math.floor(seconds / 60)
    var s = Math.floor(seconds % 60)
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s)
  }

  function saveState (state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch (e) {}
  }

  function loadState () {
    try {
      var raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch (e) { return {} }
  }

  function fetchWithRetry (url, retries) {
    retries = retries || 3
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }).catch(function (err) {
      if (retries <= 0) throw err
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(fetchWithRetry(url, retries - 1)) }, 1000)
      })
    })
  }

  // 3. 动态注入 DOM
  function createDOM () {
    if (document.getElementById('music-drawer')) return true
    injectRightsideButton()

    // 遮罩层
    var mask = document.createElement('div')
    mask.id = 'music-drawer-mask'
    document.body.appendChild(mask)

    // 抽屉面板
    var drawer = document.createElement('div')
    drawer.id = 'music-drawer'
    drawer.innerHTML =
      '<div class="music-drawer-header">' +
        '<span class="music-drawer-title">🎵 播放列表</span>' +
        '<div class="music-drawer-header-actions">' +
          '<select id="music-source-switch">' +
            '<option value="local">本地音乐</option>' +
            '<option value="netease">网易云</option>' +
            '<option value="both">全部</option>' +
          '</select>' +
          '<button id="music-drawer-close" title="关闭"><i class="fas fa-times"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="music-player-main">' +
        '<div class="music-cover-wrap">' +
          '<img id="music-cover" src="" alt="封面" />' +
        '</div>' +
        '<div class="music-info">' +
          '<div id="music-title">未播放</div>' +
          '<div id="music-artist">-</div>' +
        '</div>' +
        '<div class="music-progress">' +
          '<span id="music-current">00:00</span>' +
          '<input type="range" id="music-progress-bar" min="0" max="100" value="0" step="0.1" />' +
          '<span id="music-duration">00:00</span>' +
        '</div>' +
        '<div class="music-controls">' +
          '<button id="music-btn-prev" title="上一首"><i class="fas fa-step-backward"></i></button>' +
          '<button id="music-btn-play" title="播放/暂停"><i class="fas fa-play"></i></button>' +
          '<button id="music-btn-next" title="下一首"><i class="fas fa-step-forward"></i></button>' +
          '<button id="music-btn-order" title="播放顺序"><i class="fas fa-list-ol"></i></button>' +
        '</div>' +
        '<div class="music-volume">' +
          '<button id="music-btn-mute" title="静音"><i class="fas fa-volume-up"></i></button>' +
          '<input type="range" id="music-volume-bar" min="0" max="1" value="0.4" step="0.01" />' +
        '</div>' +
      '</div>' +
      '<ul id="music-playlist"></ul>'
    document.body.appendChild(drawer)
    return true
  }

  // 4. 注入右下角按钮
  function injectRightsideButton () {
    if (document.getElementById('music-player-btn')) return
    var show = document.getElementById('rightside-config-show')
    var goUp = document.getElementById('go-up')
    if (!show) return
    var btn = document.createElement('button')
    btn.id = 'music-player-btn'
    btn.type = 'button'
    btn.title = '音乐播放器'
    btn.innerHTML = '<i class="fas fa-music"></i>'
    if (goUp) show.insertBefore(btn, goUp)
    else show.appendChild(btn)
  }

  // 5. 播放列表管理
  function PlaylistManager () {
    this.localTracks = []
    this.neteaseTracks = []
    this.merged = []
    this.source = 'local'
  }

  PlaylistManager.prototype.loadLocal = function () {
    var self = this
    return fetchWithRetry(PLAYLIST_URL).then(function (data) {
      self.localTracks = Array.isArray(data) ? data : []
      self._merge()
      return self.localTracks
    }).catch(function () {
      self.localTracks = []
      return []
    })
  }

  PlaylistManager.prototype.loadNetease = function (id) {
    if (!id) return Promise.resolve([])
    var self = this
    var url = 'https://api.i-meto.com/meting/api?server=netease&type=playlist&id=' + id
    return fetchWithRetry(url).then(function (data) {
      self.neteaseTracks = (Array.isArray(data) ? data : []).map(function (t) {
        return {
          title: t.name || t.title,
          artist: t.artist || t.author,
          url: t.url,
          cover: t.pic || t.cover,
          album: t.album || ''
        }
      })
      self._merge()
      return self.neteaseTracks
    }).catch(function () {
      self.neteaseTracks = []
      return []
    })
  }

  PlaylistManager.prototype._merge = function () {
    var map = {}
    var list = []
    var all = this.localTracks.concat(this.neteaseTracks)
    for (var i = 0; i < all.length; i++) {
      var key = all[i].title + '|' + all[i].artist
      if (!map[key]) {
        map[key] = true
        list.push(all[i])
      }
    }
    this.merged = list
  }

  PlaylistManager.prototype.getList = function () {
    if (this.source === 'local') return this.localTracks
    if (this.source === 'netease') return this.neteaseTracks
    return this.merged
  }

  // 6. 音频引擎封装
  function AudioBridge () {
    this.audio = new Audio()
    this.audio.preload = 'auto'
    this.audio.volume = 0.4
    this._bound = false
  }

  AudioBridge.prototype.play = function () { return this.audio.play() }
  AudioBridge.prototype.pause = function () { this.audio.pause() }
  AudioBridge.prototype.seek = function (time) { this.audio.currentTime = time }
  AudioBridge.prototype.setVolume = function (v) {
    this.audio.volume = Math.max(0, Math.min(1, v))
  }
  AudioBridge.prototype.canPlayType = function (mime) {
    return this.audio.canPlayType(mime) !== ''
  }

  // 7. UI 控制器
  function DrawerController (opts) {
    this.playlist = opts.playlist
    this.bridge = opts.bridge
    this.currentIndex = 0
    this.state = State.IDLE
    this.order = 'list'
    this.isOpen = false
    this.lastVolume = 0.4
    this.els = {}

    this._cacheDom()
    this._bindUIEvents()
    this._bindBridgeEvents()
    this._restoreState()
  }

  DrawerController.prototype._cacheDom = function () {
    this.els.btn = document.getElementById('music-player-btn')
    this.els.mask = document.getElementById('music-drawer-mask')
    this.els.drawer = document.getElementById('music-drawer')
    this.els.closeBtn = document.getElementById('music-drawer-close')
    this.els.sourceSelect = document.getElementById('music-source-switch')
    this.els.cover = document.getElementById('music-cover')
    this.els.title = document.getElementById('music-title')
    this.els.artist = document.getElementById('music-artist')
    this.els.currentTime = document.getElementById('music-current')
    this.els.duration = document.getElementById('music-duration')
    this.els.progressBar = document.getElementById('music-progress-bar')
    this.els.prevBtn = document.getElementById('music-btn-prev')
    this.els.playBtn = document.getElementById('music-btn-play')
    this.els.nextBtn = document.getElementById('music-btn-next')
    this.els.orderBtn = document.getElementById('music-btn-order')
    this.els.muteBtn = document.getElementById('music-btn-mute')
    this.els.volumeBar = document.getElementById('music-volume-bar')
    this.els.playlist = document.getElementById('music-playlist')
  }

  DrawerController.prototype._bindUIEvents = function () {
    var self = this

    // 核心：点击音乐按钮打开抽屉
    if (this.els.btn) {
      this.els.btn.addEventListener('click', function () { self.open() })
    }

    // 关闭按钮 + 点击遮罩关闭
    this.els.closeBtn.addEventListener('click', function () { self.close() })
    this.els.mask.addEventListener('click', function () { self.close() })

    // 播放/暂停
    this.els.playBtn.addEventListener('click', function () { self.playPause() })

    // 上一首/下一首
    this.els.prevBtn.addEventListener('click', function () { self.prev() })
    this.els.nextBtn.addEventListener('click', function () { self.next() })

    // 进度条拖拽
    this.els.progressBar.addEventListener('input', function () {
      var list = self.playlist.getList()
      var track = list[self.currentIndex]
      if (!track) return
      var percent = parseFloat(this.value) / 100
      self.bridge.seek(track.duration ? track.duration * percent : self.bridge.audio.duration * percent)
    })

    // 音量调节
    this.els.volumeBar.addEventListener('input', function () {
      var v = parseFloat(this.value)
      self.bridge.setVolume(v)
      self.lastVolume = v
      self._updateVolumeIcon(v)
    })

    // 静音切换
    this.els.muteBtn.addEventListener('click', function () {
      if (self.bridge.audio.volume > 0) {
        self.lastVolume = self.bridge.audio.volume
        self.bridge.setVolume(0)
        self.els.volumeBar.value = 0
      } else {
        self.bridge.setVolume(self.lastVolume)
        self.els.volumeBar.value = self.lastVolume
      }
      self._updateVolumeIcon(self.bridge.audio.volume)
    })

    // 音源切换
    this.els.sourceSelect.addEventListener('change', function () {
      self.playlist.source = this.value
      self.currentIndex = 0
      self._renderPlaylist()
    })

    // 播放列表点击委托
    this.els.playlist.addEventListener('click', function (e) {
      var li = e.target.closest('li[data-index]')
      if (!li) return
      var index = parseInt(li.dataset.index, 10)
      self.playTrack(index)
    })
  }

  DrawerController.prototype._bindBridgeEvents = function () {
    var self = this
    var audio = this.bridge.audio

    audio.addEventListener('timeupdate', function () {
      self.els.currentTime.textContent = formatTime(audio.currentTime)
      if (audio.duration) {
        self.els.progressBar.value = (audio.currentTime / audio.duration) * 100
      }
    })

    audio.addEventListener('loadedmetadata', function () {
      self.els.duration.textContent = formatTime(audio.duration)
    })

    audio.addEventListener('ended', function () {
      self.next()
    })

    audio.addEventListener('play', function () {
      self.state = State.PLAYING
      self.els.playBtn.innerHTML = '<i class="fas fa-pause"></i>'
      self.els.btn.classList.add('playing')
    })

    audio.addEventListener('pause', function () {
      self.state = State.PAUSED
      self.els.playBtn.innerHTML = '<i class="fas fa-play"></i>'
      self.els.btn.classList.remove('playing')
    })
  }

  DrawerController.prototype._updateVolumeIcon = function (v) {
    var icon = v === 0 ? 'fa-volume-mute' : v < 0.5 ? 'fa-volume-down' : 'fa-volume-up'
    this.els.muteBtn.innerHTML = '<i class="fas ' + icon + '"></i>'
  }

  DrawerController.prototype._restoreState = function () {
    var state = loadState()
    if (state.volume !== undefined) {
      this.bridge.setVolume(state.volume)
      this.els.volumeBar.value = state.volume
      this.lastVolume = state.volume
      this._updateVolumeIcon(state.volume)
    }
    if (state.source) {
      this.playlist.source = state.source
      this.els.sourceSelect.value = state.source
    }
    if (state.order) this.order = state.order
  }

  DrawerController.prototype._saveCurrentState = function () {
    saveState({
      volume: this.bridge.audio.volume,
      source: this.playlist.source,
      order: this.order
    })
  }

  DrawerController.prototype._loadPlaylists = function () {
    var self = this
    var neteaseId = ''
    var meta = document.querySelector('meta[name="music-netease-id"]')
    if (meta) neteaseId = meta.content

    return Promise.all([
      this.playlist.loadLocal(),
      this.playlist.loadNetease(neteaseId)
    ]).then(function () {
      self._renderPlaylist()
    })
  }

  DrawerController.prototype._renderPlaylist = function () {
    var list = this.playlist.getList()
    var html = ''
    for (var i = 0; i < list.length; i++) {
      var active = i === this.currentIndex ? 'active' : ''
      html += '<li class="music-playlist-item ' + active + '" data-index="' + i + '">' +
        '<span class="track-title">' + list[i].title + '</span>' +
        '<span class="track-artist">' + list[i].artist + '</span>' +
      '</li>'
    }
    this.els.playlist.innerHTML = html
  }

  DrawerController.prototype.open = function () {
    this.isOpen = true
    this.els.mask.classList.add('open')
    this.els.drawer.classList.add('open')
  }

  DrawerController.prototype.close = function () {
    this.isOpen = false
    this.els.mask.classList.remove('open')
    this.els.drawer.classList.remove('open')
  }

  DrawerController.prototype.playTrack = function (index) {
    var list = this.playlist.getList()
    if (index < 0 || index >= list.length) return
    this.currentIndex = index
    var track = list[index]

    this.bridge.audio.src = track.url
    this.els.title.textContent = track.title
    this.els.artist.textContent = track.artist
    if (track.cover) this.els.cover.src = track.cover

    this.state = State.LOADING
    this.bridge.play().catch(function () {})
    this._renderPlaylist()
    this._saveCurrentState()
  }

  DrawerController.prototype.playPause = function () {
    var list = this.playlist.getList()
    if (!list.length) return

    if (this.state === State.PLAYING) {
      this.bridge.pause()
    } else if (this.state === State.PAUSED || this.state === State.IDLE) {
      if (!this.bridge.audio.src) {
        this.playTrack(this.currentIndex)
      } else {
        this.bridge.play().catch(function () {})
      }
    }
  }

  DrawerController.prototype.next = function () {
    var list = this.playlist.getList()
    if (!list.length) return
    var nextIndex
    if (this.order === 'random') {
      nextIndex = Math.floor(Math.random() * list.length)
    } else {
      nextIndex = (this.currentIndex + 1) % list.length
    }
    this.playTrack(nextIndex)
  }

  DrawerController.prototype.prev = function () {
    var list = this.playlist.getList()
    if (!list.length) return
    var prevIndex = (this.currentIndex - 1 + list.length) % list.length
    this.playTrack(prevIndex)
  }

  // 8. 初始化入口
  function init () {
    createDOM()
    if (!document.getElementById('music-drawer')) {
      console.warn('[MusicPlayer] DOM 创建失败')
      return
    }

    var pm = new PlaylistManager()
    var bridge = new AudioBridge()
    var ctrl = new DrawerController({ playlist: pm, bridge: bridge })
    ctrl._loadPlaylists()

    window.__musicPlayer = { ctrl: ctrl, playlist: pm, bridge: bridge }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // PJAX 兼容
  document.addEventListener('pjax:complete', function () {
    injectRightsideButton()
    // 重新绑定按钮事件
    var btn = document.getElementById('music-player-btn')
    if (btn && window.__musicPlayer && window.__musicPlayer.ctrl) {
      var ctrl = window.__musicPlayer.ctrl
      btn.addEventListener('click', function () { ctrl.open() })
    }
  })
})()