var CordovaFileCache = require('cordova-file-cache');
var CordovaPromiseFS = require('cordova-promise-fs');
var Promise = null;

//移除 windows.location.href 路徑中的 hash 部分
var BUNDLE_ROOT = location.href.replace(location.hash,'');
BUNDLE_ROOT = BUNDLE_ROOT.substr(0,BUNDLE_ROOT.lastIndexOf('/')+1);
// pathname 就是 url host 以後的子路徑
//若是 cordova 環境是 iphone, 就從 /www/ 開始抽取 bundle root
if(/ip(hone|ad|od)/i.test(navigator.userAgent)){
  BUNDLE_ROOT = location.pathname.substr(location.pathname.indexOf('/www/'));
  BUNDLE_ROOT = BUNDLE_ROOT.substr(0,BUNDLE_ROOT.lastIndexOf('/')+1);
  BUNDLE_ROOT = 'cdvfile://localhost/bundle' + BUNDLE_ROOT;
}

function hash(files){
  var keys = Object.keys(files);
  keys.sort();
  var str = '';
  keys.forEach(function(key){
    if(files[key] && files[key].version);
      str += '@' + files[key].version;
  });
  return CordovaFileCache.hash(str) + '';
}

function AppLoader(options){
  if(!options) {
	throw new Error('CordovaAppLoader has no options!');  
  }
  if(!options.fs) {
	throw new Error('CordovaAppLoader has no "fs" option (cordova-promise-fs)');  
  }
  if(!options.serverRoot) {
	throw new Error('CordovaAppLoader has no "serverRoot" option.');  
  }
  if(!window.pegasus || !window.Manifest) throw new Error('CordovaAppLoader bootstrap.js is missing.');
  this.allowServerRootFromManifest = options.allowServerRootFromManifest === true;//??
  Promise = options.fs.Promise;

  // initialize variables ??
  this.manifest = window.Manifest;
  this.newManifest = null;
  this.bundledManifest = null;
  this._lastUpdateFiles = localStorage.getItem('last_update_files');

  // normalize serverRoot and set remote manifest url
  options.serverRoot = options.serverRoot || '';
  if(!!options.serverRoot && options.serverRoot[options.serverRoot.length-1] !== '/') options.serverRoot += '/';
  this.newManifestUrl = options.manifestUrl || options.serverRoot + (options.manifest || 'manifest.json');

  // initialize a file cache
  if(options.mode) options.mode = 'mirror';
  this.cache = new CordovaFileCache(options);

  // private stuff ??
  this.corruptNewManifest = false;
  this._toBeCopied = [];
  this._toBeDeleted = [];
  this._toBeDownloaded = [];
  this._updateReady = false;
  //讀取應用程式內容列表之時間限制
  this._checkTimeout = options.checkTimeout || 10000;
}

AppLoader.prototype._createFilemap = function(files){
  var result = {};
  var normalize = this.cache._fs.normalize;
  Object.keys(files).forEach(function(key){
    files[key].filename = normalize(files[key].filename);
    result[files[key].filename] = files[key];
  });
  return result;
};

//下載遠端應用程式包裡的特定檔案到本地的檔案系統
AppLoader.prototype.copyFromBundle = function(file){
  var url = BUNDLE_ROOT + file;
  return this.cache._fs.download(url,this.cache.localRoot + file);
};

//取得本地網頁上應用程式包的內容列表
AppLoader.prototype.getBundledManifest = function(){
  var self = this;
  var bootstrapScript = document.querySelector('script[manifest]');
  var bundledManifestUrl = (bootstrapScript? bootstrapScript.getAttribute('manifest'): null) || 'manifest.json';

  return new Promise(function(resolve,reject){
    if(self.bundledManifest) {
      resolve(self.bundledManifest);
    } else {
      pegasus(bundledManifestUrl).then(function(bundledManifest){
        self.bundledManifest = bundledManifest;
        resolve(bundledManifest);
      },reject);
      setTimeout(function(){reject(new Error('bundled manifest timeout'));},self._checkTimeout);
    }
  });
};

AppLoader.prototype.check = function(newManifest){
  var self = this,
	  manifest = this.manifest;
  if(typeof newManifest === "string") {
    self.newManifestUrl = newManifest;
    newManifest = undefined;
  }

  //要是有提供新版的應用程式內容清單路徑, 就去取得新版的應用程式內容清單
  var gotNewManifest = new Promise(function(resolve,reject){
    if(typeof newManifest === "object") {
      resolve(newManifest);
    } else {
      pegasus(self.newManifestUrl).then(resolve,reject);
      setTimeout(function(){reject(new Error('new manifest timeout'));},self._checkTimeout);
    }
  });

  return new Promise(function(resolve,reject){
	//在取得本地與新的應用程式內容清單, 以及本地程式檔案列表之後....
    Promise.all([gotNewManifest,self.getBundledManifest(),self.cache.list()])
      .then(function(values){
        var newManifest = values[0];
        var bundledManifest = values[1];
        var newFiles = hash(newManifest.files);

        // Prevent end-less update loop, check if new manifest
        // has been downloaded before (but failes)
        
        // Check if the newFiles match the previous files (last_update_files)
        if(newFiles === self._lastUpdateFiles) {
          // YES! So we're doing the same update again!

          // Check if our current Manifest has indeed the "last_update_files"
          var currentFiles = hash(Manifest.files);
          if(self._lastUpdateFiles !== currentFiles){
            // No! So we've updated, yet they don't appear in our manifest. This means:
            console.warn('New manifest available, but an earlier update attempt failed. Will not download.');
            self.corruptNewManifest = true;
            resolve(null);
          }
          // Yes, we've updated and we've succeeded.
          resolve(false);
          return;
        }

        // Check if new manifest is valid
        if(!newManifest.files){
          reject('Downloaded Manifest does not have "files" attribute.');
          return;
        }

        // We're good to go check! Get all the files we need
        var cachedFiles = values[2]; //Application files which were already saved in local cache.
        var oldFiles = self._createFilemap(manifest.files); // Application files listed in current manifest. ??
        var newFiles = self._createFilemap(newManifest.files); // Application files listed in new manifest.
        var bundledFiles = self._createFilemap(bundledManifest.files); // Application files listed in app bundle.

        // Create COPY and DOWNLOAD lists
        self._toBeDownloaded = [];
        self._toBeCopied = [];
        self._toBeDeleted= [];
        var isCordova = self.cache._fs.isCordova;
        Object.keys(newFiles)
          //Pick up those application files which should download from remote server, ...
          .filter(function(file){
                    // if the file was not available in previous version....
            return !oldFiles[file] ||
                    // or the version of the file has changed...
                    oldFiles[file].version !== newFiles[file].version ||
                    // or it was not in cache for some reason...
                    !self.cache.isCached(file);
          })
          // then we add these files to the correct list
          .forEach(function(file){
            // if the version of bundled application file matches version of new application file, then we can copy it!
            if(isCordova && bundledFiles[file] && bundledFiles[file].version === newFiles[file].version){
              self._toBeCopied.push(file);
            // Othwerwise, we download it from remote server.
            } else {
              self._toBeDownloaded.push(file);
            }
          });

		// Delete files
        self._toBeDeleted = cachedFiles
          .map(function(file){
            return file.substr(self.cache.localRoot.length);
          })
          .filter(function(file){
                  // Everything that is not in new manifest... which means these files does not exist in new version...NOT SURE
            return !newFiles[file] ||
                  // Files that will be downloaded from remote server, which means a new version of these files was released... NOT SURE
                   self._toBeDownloaded.indexOf(file) >= 0 ||
                  // Files that will be copied from bundled application
                   self._toBeCopied.indexOf(file) >= 0;
          });

		// Do calculation to find out how many files have to be modified in the new version.
		// If we don't have to download any file from remote or delete any file in local bundle, 
	    // which means this app does not have new release, then we can keep serving from local bundle!
        var changes = self._toBeDeleted.length + self._toBeDownloaded.length;
        
        if(changes > 0){
          // Save the new Manifest
          self.newManifest = newManifest;
          self.newManifest.root = self.cache.localInternalURL;
          resolve(true);
        } else {
          resolve(false);
        }
      }, function(err){
        reject(err);
      }); // end of .then
  }); // end of new Promise
};

AppLoader.prototype.canDownload = function(){
  return !!this.newManifest && !this._updateReady;
};

AppLoader.prototype.canUpdate = function(){
  return this._updateReady;
};

AppLoader.prototype.download = function(onprogress){
  var self = this;
  if(!self.canDownload()) {
    return new Promise(function(resolve){ resolve(null); });
  }
  // we will delete files, which will invalidate the current manifest...
  localStorage.removeItem('manifest');
  // only attempt this once - set 'last_update_files'
  localStorage.setItem('last_update_files',hash(this.newManifest.files));
  this.manifest.files = Manifest.files = {};
  return self.cache.remove(self._toBeDeleted,true)
    .then(function(){
      return Promise.all(self._toBeCopied.map(function(file){
        return self.cache._fs.download(BUNDLE_ROOT + file,self.cache.localRoot + file);
      }));
    })
    .then(function(){
      if(self.allowServerRootFromManifest && self.newManifest.serverRoot){
        self.cache.serverRoot = self.newManifest.serverRoot;
      }
      self.cache.add(self._toBeDownloaded);
      return self.cache.download(onprogress);
    }).then(function(){
      self._toBeDeleted = [];
      self._toBeDownloaded = [];
      self._updateReady = true;
      return self.newManifest;
    },function(files){
      // on download error, remove files...
      if(!!files && files.length){
        self.cache.remove(files);
      }
      return files;
    });
};

AppLoader.prototype.update = function(reload){
  if(this._updateReady) {
    localStorage.setItem('manifest',JSON.stringify(this.newManifest));
    if(reload !== false) location.reload();
    return true;
  }
  return false;
};

//清除本地的更新紀錄與應用程式內容清單
AppLoader.prototype.clear = function(){
  localStorage.removeItem('last_update_files');
  localStorage.removeItem('manifest');
  return this.cache.clear();
};

//重新載入網頁
AppLoader.prototype.reset = function(){
  return this.clear().then(function(){
    location.reload();
  },function(){
    location.reload();
  });
};

module.exports = AppLoader;