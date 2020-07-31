const yaml = require('js-yaml');
const _ = require('the-lodash');
const Promise = require('the-promise');
const fs = require('fs').promises;
const Path = require('path');
const ClusterResolver = require('./resolver');

class ClusterEngine
{
    constructor(context) {
        this._context = context;
        this._logger = context.logger.sublogger('ClusterEngine');
        this._token = null;
        this._caData = null;

        this._clustersDict = {};
        this._clustersList = [];

        this._selectedClusterConfig = null;
    }

    get logger() {
        return this._logger;
    }

    init()
    {
        var configFilePath = process.env.KUBECONFIG || '~/.kube/config';
        return this._loadConfigFile(configFilePath)
            .then(config => {
                config = config || {};
                config.contexts = config.contexts || [];
                config.clusters = config.clusters || [];
                config.users = config.users || [];

                var usersDict = _.makeDict(config.users, x => x.name, x => x.user);
                var clustersDict = _.makeDict(config.clusters, x => x.name, x => x.cluster);

                this._clustersDict = _.makeDict(config.contexts, x => x.name, x => {
                    return this._buildClusterConfig(x, usersDict, clustersDict);
                });
            })
            .then(() => {
                return Promise.serial(_.values(this._clustersDict), x => this._processCluster(x))
            })
            .then(() => {
                this._clustersList = _.values(this._clustersDict).map(x => ({
                    name: x.name,
                    kind: x.kind,
                    ready: x.ready
                }));
                this._clustersList = _.orderBy(this._clustersList, x => x.name);
            })
            ;
    }

    _buildClusterConfig(contextConfig, usersDict, clustersDict)
    {
        var config = {
            name: contextConfig.name,
            cluster: clustersDict[contextConfig.context.cluster] || null,
            user: usersDict[contextConfig.context.user] || null,
        };
        config.kind = this._determineKind(config);
        return config;
    }

    _processCluster(clusterConfig)
    {
        this.logger.info("[_processCluster] ", clusterConfig)
        var resolver = new ClusterResolver(this.logger, clusterConfig);
        return resolver.resolve()
            .then(() => {
                this.logger.info("[_processCluster] PostResolve: ", clusterConfig)
            });
    }

    _determineKind(config)
    {
        const url = new URL(config.cluster.server)

        if (config.name == 'docker-for-desktop') {
            return 'docker';
        }
        if (config.name == 'minikube') {
            return 'minikube';
        }

        if (url.origin.endsWith('azmk8s.io')) {
            return 'aks'
        }

        if (config.user)
        {
            if (config.user['auth-provider'])
            {
                if (config.user['auth-provider']['name'] == 'gcp')
                {
                    return 'gcp';
                }
            }
            if (config.user['exec'])
            {
                if (config.user['exec']['command'] == 'doctl')
                {
                    return 'do';
                }

                if (config.user['exec']['command'] == 'aws') {
                    return 'aws'
                }
            }
        }
        return 'k8s';
    }

    _loadConfigFile(fileName)
    {
        return fs.readFile(fileName, 'utf8')
            .then(content => {
                const doc = yaml.safeLoad(content);
                return doc;
            })
            .catch(reason => {
                this.logger.error('Failed to load %s. Details: ', fileName, reason);
                return null;
            });
    }

    fetchList() {
        return this._clustersList;
    }

    fetchDetails(name)
    {
        var clusterConfig = this._clustersDict[name];
        if (!clusterConfig) {
            return null;
        }

        var details = {
            name: clusterConfig.name,
            kind: clusterConfig.kind,
            ready: clusterConfig.ready,
            messages: clusterConfig.messages
        }

        if (!clusterConfig.ready)
        {
            details.runCommands = this._generateRunCommands(clusterConfig);
        }

        return details;
    }

    _generateRunCommands(clusterConfig)
    {
        var mappings = {
            '/root/.kube/config': {
                needWrite: false,
                os: {
                    [ClusterResolver.OS_DEFAULT]: '~/.kube/config'
                }
            } 
        }

        this.logger.info("[_generateRunCommands] FileMappings: ", clusterConfig.fileMappings);

        mappings = _.defaults(mappings, clusterConfig.fileMappings);

        this.logger.info("[_generateRunCommands] Combined Mappings: ", mappings);

        var commands = [];

        for(var x of ClusterResolver.OS_LIST)
        {
            commands.push({
                'os': x,
                'command': this._generateRunCommandForOS(x, mappings)
            })
        }

        this.logger.info("[_generateRunCommands] Commands: ", commands);

        return commands;
    }

    _generateRunCommandForOS(os, mappings)
    {
        var cmd =
            "docker run --rm -it \\\n" + 
            "  -p 5001:5001 \\\n";

        for(var x of _.keys(mappings))
        {
            var mappingInfo = mappings[x];
            var sourcePath = mappingInfo.os[os];
            if (!sourcePath) {
                sourcePath = mappingInfo.os[ClusterResolver.OS_DEFAULT];
            }
            if (sourcePath)
            {
                var binding =  sourcePath + ":" + x;
                var flag = "";
                if (!mappingInfo.needWrite) {
                    flag = ":ro";
                }
                cmd += "  -v " + binding + flag + " \\\n";
            }
        }
        
        cmd += '  kubevious/portable';

        return cmd;
    }

    getActiveCluster() {
        if (this._selectedClusterConfig) {
            return {
                name: this._selectedClusterConfig.name,
                kind: this._selectedClusterConfig.kind
            }
        }
        return null;
    }

    setActiveCluster(clusterName) {
        var config = this._clustersDict[clusterName] || null;
        if (!config) {
            return {
                success: false,
                messages: [
                    "Unknown cluster: " + clusterName
                ]
            };
        }
        if (!config.ready) {
            return {
                success: false,
                messages: config.messages,
                runCommands: this._generateRunCommands(config)
            };
        }

        this._selectedClusterConfig = config;

        this._context.websocket.update({ kind: 'active-cluster' }, this.getActiveCluster());

        this._context.parserContext.stopLoaders();
        return this._context.parserContext.activateLoader(this._selectedClusterConfig);
    }
}

module.exports = ClusterEngine
