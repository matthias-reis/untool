'use strict';

const { existsSync: exists } = require('fs');
const { join } = require('path');

const debug = require('debug')('untool:webpack:stats');
const {
  sync: { sequence, callable: callableSync },
  async: { callable: callableAsync },
} = require('mixinable');

const { Mixin } = require('@untool/core');

const { Resolvable } = require('./lib/utils/resolvable');

class WebpackMixin extends Mixin {
  constructor(...args) {
    super(...args);
    this.stats = new Resolvable();
  }
  clean() {
    const rimraf = require('rimraf');
    const { buildDir, serverDir } = this.config;
    return Promise.all([
      new Promise((resolve, reject) =>
        rimraf(buildDir, (error) => (error ? reject(error) : resolve()))
      ),
      new Promise((resolve, reject) =>
        rimraf(serverDir, (error) => (error ? reject(error) : resolve()))
      ),
    ]);
  }
  build() {
    const webpack = require('webpack');
    const webpackConfig = (({ static: isStatic }) => {
      if (isStatic) {
        return this.getBuildConfig('build');
      } else {
        return [this.getBuildConfig('build'), this.getBuildConfig('node')];
      }
    })(this.options);
    return new Promise((resolve, reject) =>
      webpack(webpackConfig).run((error, stats) => {
        if (error) {
          reject(error);
        } else if (stats.hasErrors()) {
          const { errors } = stats.toJson();
          reject(new Error(`Can't compile:\n${errors.join('\n')}`));
        } else {
          resolve(stats);
        }
      })
    ).then((stats) => void this.inspectBuild(stats, webpackConfig) || stats);
  }
  getBuildStats() {
    return Promise.resolve(this.stats);
  }
  getBuildConfig(target, baseConfig) {
    const { loaderConfigs = {}, ...webpackConfig } = (() => {
      switch (baseConfig || target) {
        case 'build':
          return require('./lib/configs/build')(this.config);
        case 'develop':
          return require('./lib/configs/develop')(this.config);
        case 'node':
          return require('./lib/configs/node')(this.config);
        default:
          if (baseConfig && exists(baseConfig)) {
            return require(baseConfig)(this.config);
          }
          throw new Error(`Can't get build config ${baseConfig || target}`);
      }
    })();
    this.configureBuild(webpackConfig, loaderConfigs, target);
    return webpackConfig;
  }
  configureBuild(webpackConfig, loaderConfigs, target) {
    const { plugins, module } = webpackConfig;
    const configLoaderConfig = {
      test: require.resolve('@untool/core/lib/config'),
      loader: require.resolve('./lib/utils/loader'),
      options: { type: target, config: this.config },
    };
    if (target === 'node') {
      const { StatsFilePlugin } = require('./lib/plugins/stats');
      plugins.unshift(new StatsFilePlugin(this));
      configLoaderConfig.options.type = 'server';
    }
    if (target === 'develop' || target === 'build') {
      const { StatsPlugin } = require('./lib/plugins/stats');
      plugins.unshift(new StatsPlugin(this));
      configLoaderConfig.options.type = 'browser';
    }
    if (target === 'build' && this.options.static) {
      const { RenderPlugin } = require('./lib/plugins/render');
      plugins.push(new RenderPlugin(this));
    }
    module.rules.push(configLoaderConfig);
  }
  configureServer(app, middlewares, mode) {
    if (mode === 'develop') {
      const webpack = require('webpack');
      const createWebpackDevMiddleware = require('webpack-dev-middleware');
      const createWebpackHotMiddleware = require('webpack-hot-middleware');
      const webpackDevelopConfig = this.getBuildConfig('develop');
      const compiler = webpack(webpackDevelopConfig);
      middlewares.initial.push(
        createWebpackDevMiddleware(compiler, {
          noInfo: true,
          logLevel: 'silent',
          publicPath: webpackDevelopConfig.output.publicPath,
          watchOptions: webpackDevelopConfig.watchOptions,
        }),
        createWebpackHotMiddleware(compiler, { log: false })
      );
    }
    if (mode === 'static' || mode === 'develop') {
      const createRenderMiddleware = require('./lib/middleware/render');
      const webpackNodeConfig = this.getBuildConfig('node');
      middlewares.routes.push(
        createRenderMiddleware(webpackNodeConfig, mode === 'develop')
      );
    }
    if (mode === 'serve') {
      const { serverDir, serverFile, statsFile } = this.config;
      const serverFilePath = join(serverDir, serverFile);
      const statsFilePath = join(serverDir, statsFile);
      this.stats.resolve(exists(statsFilePath) ? require(statsFilePath) : {});
      if (exists(serverFilePath)) {
        middlewares.routes.push(require(serverFilePath).default);
      }
    }
    const createStatsMiddleware = require('./lib/middleware/stats');
    middlewares.preroutes.push(createStatsMiddleware(this));
  }
  registerCommands(yargs) {
    const { name } = this.config;
    yargs
      .command(
        this.configureCommand({
          command: 'start',
          describe: `Build and serve ${name}`,
          builder: {
            production: {
              alias: 'p',
              default: false,
              describe: 'Enable production mode',
              type: 'boolean',
            },
            static: {
              alias: 's',
              default: false,
              describe: 'Statically build locations',
              type: 'boolean',
            },
            clean: {
              alias: 'c',
              default: true,
              describe: 'Clean up before building',
              type: 'boolean',
            },
          },
          handler: (argv) => {
            if (argv.production) {
              Promise.resolve(argv.clean && this.clean())
                .then(this.build)
                .then(this.runServer.bind(this, 'serve'))
                .catch(this.handleError);
            } else {
              this.clean()
                .then(this.runServer.bind(this, 'develop'))
                .catch(this.handleError);
            }
          },
        })
      )
      .command(
        this.configureCommand({
          command: 'build',
          describe: `Build ${name}`,
          builder: {
            production: {
              alias: 'p',
              default: false,
              describe: 'Enable production mode',
              type: 'boolean',
            },
            static: {
              alias: 's',
              default: false,
              describe: 'Statically build locations',
              type: 'boolean',
            },
            clean: {
              alias: 'c',
              default: true,
              describe: 'Clean up before building',
              type: 'boolean',
            },
          },
          handler: (argv) =>
            Promise.resolve(argv.clean && this.clean())
              .then(this.build)
              .catch(this.handleError),
        })
      )
      .command(
        this.configureCommand({
          command: 'develop',
          describe: `Serve ${name} in watch mode`,
          builder: {},
          handler: () =>
            this.clean()
              .then(this.runServer.bind(this, 'develop'))
              .catch(this.handleError),
        })
      );
  }
  handleArguments(argv) {
    this.options = { ...this.options, ...argv };
  }
  inspectBuild(stats) {
    debug(
      stats.toString({ chunks: false, modules: false, entrypoints: false })
    );
  }
}

WebpackMixin.strategies = {
  configureBuild: sequence,
  inspectBuild: sequence,
  getBuildStats: callableAsync,
  getBuildConfig: callableSync,
  build: callableAsync,
  clean: callableAsync,
};

module.exports = WebpackMixin;
