'use strict';

Evme.InstalledAppResult = function Evme_InstalledAppResult() {
  Evme.Result.call(this);
  this.type = Evme.RESULT_TYPE.INSTALLED;

  // @override
  this.launch = function launchInstalledApp(){
    EvmeManager.openInstalledApp({
      "id": this.cfg.id,
      "origin": this.cfg.appUrl
    });
  };
};
Evme.InstalledAppResult.prototype = Object.create(Evme.Result.prototype);
Evme.InstalledAppResult.prototype.constructor = Evme.InstalledAppResult;

/*
Renders installed apps
*/
Evme.InstalledAppsRenderer = function Evme_InstalledAppsRenderer() {
  var NAME = "InstalledAppsRenderer",
      DEFAULT_ICON = Evme.Utils.getDefaultAppIcon(),
      self = this,
      appsSignature = Evme.Utils.EMPTY_APPS_SIGNATURE,
      containerEl;

  this.init = function init(cfg) {
    containerEl = cfg.containerEl;
  };

  this.render = function render(data) {
    var apps = Evme.InstalledAppsService.getMatchingApps(data),
        newSignature = Evme.Utils.getAppsSignature(apps);

    if (!apps || !apps.length) {
      self.clear();
      return;
    }

    if (appsSignature === newSignature) {
      Evme.Utils.log("InstalledAppsRenderer: nothing new to render (signatures match)");

    } else {
      self.clear();
      renderDocFrag(apps);
      appsSignature = newSignature;
    }
  };

  this.clear = function clear() {
    containerEl.innerHTML = '';
    appsSignature = Evme.Utils.EMPTY_APPS_SIGNATURE;
  };

  this.getResultCount = function getResultCount() {
    return containerEl.childElementCount;
  };

  function renderDocFrag(apps) {
    var docFrag = document.createDocumentFragment();

    for (var i = 0, app; app = apps[i++];) {
      var result = new Evme.InstalledAppResult(),
          el = result.init(app);

      result.draw(app.icon || DEFAULT_ICON);
      docFrag.appendChild(el);
    }
    containerEl.appendChild(docFrag);
  }
};

/*
Responsible for maintaining app indexes

App index - list of apps installed on device, including apps and bookmarks but *excluding* collections
[
  {app id}: {
    "name": {display name},
    "icon": {HTML element},
    "appUrl": {app url}
  },
  ...
]

 Query index - a mapping from experience name to app ids (manifestURLs or bookmarkURLs)
{
  "music": ["manifestURL1", "bookmarkURL1"],
  "top apps": ["manifestURL2", "bookmarkURL2"],
  "radio": ["manifestURL3", "bookmarkURL3"],
  ...
}
*/
Evme.InstalledAppsService = new function Evme_InstalledAppsService() {
  var NAME = "InstalledAppsService",
      self = this,
      appIndex = {}, APP_INDEX_STORAGE_KEY = NAME + "-app-index",
      queryIndex = {}, QUERY_INDEX_STORAGE_KEY = NAME + "-query-index",
      appIndexPendingSubscribers = [],
      appIndexComplete = false,

      // used to link api results (by guid) to installed apps (by manifestURL)
      // during the creation on queryIndex
      // maps https://mobile.twitter.com/cache/twitter.webapp
      // -> https://mobile.twitter.com/cache/twitter.webapp?feature_profile=1f5eea7f83db.45.2
      guidsToManifestURLs = null;

  this.init = function init() {
    // create indexes
    createAppIndex();
    loadQueryIndex();

    // listeners
    window.addEventListener('appInstalled', onAppInstallChanged);
    window.addEventListener('appUninstalled', onAppInstallChanged);
  };

  this.requestAppsInfo = function requestAppsInfo() {
    guidsToManifestURLs = {};

    var gridApps = EvmeManager.getGridApps(),
        guids = [];
    
    for (var i = 0, gridApp; gridApp = gridApps[i++]; ) {
      var guid = gridApp.app.bookmarkURL;
      
      // use manifestURL
      if (!guid) {
        guid = manifestURLtoGuid(gridApp.app.manifestURL);
        
        // save a reference to the original manifestURL
        if (guid !== gridApp.app.manifestURL) {
          guidsToManifestURLs[guid] = gridApp.app.manifestURL;
        }
      }
      
      guids.push(guid);
    }

    Evme.EventHandler.trigger(NAME, "requestAppsInfo", guids);
  };

  this.requestAppsInfoCb = function requestAppsInfoCb(appsInfoFromAPI) {
    queryIndex = {};

    for (var k in appsInfoFromAPI) {
      var apiInfo = appsInfoFromAPI[k];

      // verify that the app info relates to an existing one in the appIndex
      // the guid might be a "cleaned" manifestURL
      var idInAppIndex = guidsToManifestURLs[apiInfo.guid] || apiInfo.guid;

      if (!(idInAppIndex in appIndex)) {
        continue;
      }

      // Store the marketplace api slug, in order to compare and dedup Marketplace app suggestions later on
      appIndex[idInAppIndex].slug = apiInfo.nativeId;

      // queries is comprised of tags and experiences
      var tags = apiInfo.tags || [],
      experiences = apiInfo.experiences || [],
      queries = Evme.Utils.unique(tags.concat(experiences));

      // populate queryIndex
      for (var i = 0, query; query = queries[i++];) {
        query = normalizeQuery(query);
        if (!(query in queryIndex)) {
          queryIndex[query] = [];
        }
        queryIndex[query].push(idInAppIndex);
      }
    }

    guidsToManifestURLs = null;
    Evme.Storage.set(QUERY_INDEX_STORAGE_KEY, queryIndex);
    Evme.EventHandler.trigger(NAME, "queryIndexUpdated");
  };

  this.getMatchingApps = function getMatchingApps(data) {
    var matchingApps = [],
        query;

    if (data.query) {
      query = data.query;
    } else if (data.experienceId) {
      query = Evme.Utils.shortcutIdToKey(data.experienceId);
    }

    if (!query) {
      return matchingApps;
    }
    
    query = normalizeQuery(query);

    // search appIndex
    // search query within first letters of app name words
    var regex = new RegExp('\\b' + query, 'i');
    for (var appId in appIndex) {
      // if there's a match, add to matchingApps
      var app = appIndex[appId];
      if ("name" in app && regex.test(app.name)) {
        matchingApps.push(app);
      }
    }

    // search query
    // search for only exact query match
    if (query in queryIndex) {
      for (var i = 0, appId; appId = queryIndex[query][i++];) {
        if (appId in appIndex) {
          var app = appIndex[appId];
          matchingApps.push(app);
        }
      }
    }

    matchingApps = Evme.Utils.unique(matchingApps, 'id');

    return matchingApps;
  };


  this.getAppById = function getAppById(appId, cb) {
    if (appIndexComplete) {
      cb(appIndex[appId]);
    } else {
      appIndexPendingSubscribers.push([appId, cb])
    }
  };

  this.getApps = function() {
    return appIndex;
  };

  this.getSlugs = function getAPIIds() {
    var ids = [];
    for (var id in appIndex) {
      var app = appIndex[id];
      app.slug && ids.push(app.slug);
    }
    return ids;
  };

  function onAppInstallChanged() {
    createAppIndex();
  }

  function createAppIndex() {
    // empty current index and create a new one
    appIndex = {};

    appIndexComplete = false;

    var gridApps = EvmeManager.getGridApps(),
        gridAppsCount = gridApps.length;

    for (var i = 0, gridApp; gridApp = gridApps[i++];) {
      var appInfo = EvmeManager.getAppInfo(gridApp, function onAppInfo(appInfo){
        appIndex[appInfo.id] = appInfo;
        if (--gridAppsCount === 0) {
          onAppIndexComplete();
        }
      });
    }
  }

  function manifestURLtoGuid(str) {
    return str && str.split("?")[0];
  }

  function onAppIndexComplete() {
    appIndexComplete = true;
    self.requestAppsInfo();
    appIndexPendingSubscribers.forEach(function execute(args) {
      self.getAppById.apply(self, args);
    });
    appIndexPendingSubscribers = [];
  }

  function loadQueryIndex() {
    Evme.Storage.get(QUERY_INDEX_STORAGE_KEY, function queryIndexCb(queryIndexFromStorage) {
      if (queryIndexFromStorage) {
        queryIndex = queryIndexFromStorage;
      } else {
        self.requestAppsInfo();
      }
    });
  }

  function normalizeQuery(query) {
    return Evme.Utils.escapeRegexp(query.toLowerCase());
  }
};
