'use strict';

const { dirname, join } = require('path');

const cosmiconfig = require('cosmiconfig');
const { compatibleMessage } = require('check-error');

const { merge } = require('./utils');
const { resolve, resolvePreset, isResolveError } = require('./resolver');

class Loader {
  constructor(namespace, pkgData) {
    this.namespace = namespace;
    this.pkgData = pkgData;
  }
  load(context, module) {
    const { loadSync } = cosmiconfig(this.namespace);
    return loadSync(resolvePreset(context, module));
  }
  search(stopDir) {
    const { searchSync } = cosmiconfig(this.namespace, { stopDir });
    return searchSync(stopDir);
  }
  loadPreset(context, preset) {
    try {
      return this.load(context, preset);
    } catch (error) {
      if (!isResolveError(error)) throw error;
      try {
        return this.search(dirname(resolve(context, `${preset}/package.json`)));
      } catch (error) {
        if (!isResolveError(error)) throw error;
        throw new Error(`Can't find preset '${preset}' in '${context}'`);
      }
    }
  }
  loadPresets(context, presets = []) {
    return presets.reduce((result, preset) => {
      const { config, filepath } = this.loadPreset(context, preset);
      const directory = dirname(filepath);
      if (config.mixins) {
        config.mixins = config.mixins.map((mixin) =>
          mixin.startsWith('.') ? join(directory, mixin) : mixin
        );
      }
      return merge(result, this.loadPresets(directory, config.presets), config);
    }, {});
  }
  loadSettings(context) {
    const result = this.search(context);
    const settings = { ...(result && result.config) };
    if (!settings.presets) {
      settings.presets = this.getDependencies().filter((dep) => {
        try {
          return !!this.loadPreset(context, dep);
        } catch (error) {
          if (!compatibleMessage(error, /^Can't find preset/)) throw error;
        }
      });
    }
    return settings;
  }
  getDependencies() {
    const { dependencies = {}, devDependencies = {} } = this.pkgData;
    return [
      ...Object.keys(dependencies),
      ...(process.env.NODE_ENV !== 'production'
        ? Object.keys(devDependencies)
        : []),
    ];
  }
}

exports.loadConfig = (namespace, pkgData, rootDir) => {
  const loader = new Loader(namespace, pkgData);

  const settings = loader.loadSettings(rootDir);
  const presets = loader.loadPresets(rootDir, settings.presets);

  // eslint-disable-next-line no-unused-vars
  const { presets: _, ...config } = merge(presets, settings);
  return config;
};
