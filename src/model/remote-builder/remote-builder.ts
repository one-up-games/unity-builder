import AWSBuildPlatform from './aws-build-platform';
import * as core from '@actions/core';
import { BuildParameters } from '..';
import RemoteBuilderNamespace from './remote-builder-namespace';
import RemoteBuilderSecret from './remote-builder-secret';
import { RemoteBuilderProviderInterface } from './remote-builder-provider-interface';
import Kubernetes from './kubernetes-build-platform';
import RemoteBuilderEnvironmentVariable from './remote-builder-environment-variable';
import ImageEnvironmentFactory from '../image-environment-factory';
import YAML from 'yaml';
const repositoryFolder = 'repo';
const buildVolumeFolder = 'data';
const cacheFolder = 'cache';

class RemoteBuilder {
  static RemoteBuilderProviderPlatform: RemoteBuilderProviderInterface;
  private static buildParams: BuildParameters;
  private static defaultSecrets: RemoteBuilderSecret[];
  private static buildId: string;
  private static branchName: string;
  private static buildPathFull: string;
  private static builderPathFull: string;
  private static steamPathFull: string;
  private static repoPathFull: string;
  private static projectPathFull: string;
  private static libraryFolderFull: string;
  private static cacheFolderFull: string;
  static SteamDeploy: boolean = process.env.STEAM_DEPLOY !== undefined || false;
  private static readonly defaultGitShaEnvironmentVariable = [
    {
      name: 'GITHUB_SHA',
      value: process.env.GITHUB_SHA || '',
    },
  ];

  static async build(buildParameters: BuildParameters, baseImage) {
    const t = Date.now();
    RemoteBuilder.buildId = RemoteBuilderNamespace.generateBuildName(
      RemoteBuilder.readRunNumber(),
      buildParameters.platform,
    );
    RemoteBuilder.buildParams = buildParameters;
    RemoteBuilder.setupBranchName();
    RemoteBuilder.setupFolderVariables();
    RemoteBuilder.setupDefaultSecrets();
    try {
      RemoteBuilder.setupBuildPlatform();
      await this.RemoteBuilderProviderPlatform.setupSharedBuildResources(
        this.buildId,
        this.buildParams,
        this.branchName,
        this.defaultSecrets,
      );
      await RemoteBuilder.SetupStep();
      const t2 = Date.now();
      core.info(`Setup time: ${Math.floor((t2 - t) / 1000)}`);
      await RemoteBuilder.BuildStep(baseImage);
      const t3 = Date.now();
      core.info(`Build time: ${Math.floor((t3 - t2) / 1000)}`);
      core.info(`Post build steps ${this.buildParams.postBuildSteps}`);
      this.buildParams.postBuildSteps = YAML.parse(this.buildParams.postBuildSteps);
      core.info(`Post build steps ${JSON.stringify(this.buildParams.postBuildSteps, undefined, 4)}`);
      for (const step of this.buildParams.postBuildSteps) {
        await this.RemoteBuilderProviderPlatform.runBuildTask(
          this.buildId,
          step['image'],
          step['commands'],
          `/${buildVolumeFolder}`,
          `/${buildVolumeFolder}`,
          [
            {
              name: 'GITHUB_SHA',
              value: process.env.GITHUB_SHA || '',
            },
          ],
          this.defaultSecrets,
        );
      }
      await RemoteBuilder.CompressionStep();
      await RemoteBuilder.UploadArtifacts();
      if (this.SteamDeploy) await RemoteBuilder.DeployToSteam();
      await this.RemoteBuilderProviderPlatform.cleanupSharedBuildResources(
        this.buildId,
        this.buildParams,
        this.branchName,
        this.defaultSecrets,
      );
    } catch (error) {
      await RemoteBuilder.handleException(error);
      throw error;
    }
  }

  private static setupFolderVariables() {
    this.buildPathFull = `/${buildVolumeFolder}/${this.buildId}`;
    this.builderPathFull = `${this.buildPathFull}/builder`;
    this.steamPathFull = `${this.buildPathFull}/steam`;
    this.repoPathFull = `${this.buildPathFull}/${repositoryFolder}`;
    this.projectPathFull = `${this.repoPathFull}/${this.buildParams.projectPath}`;
    this.libraryFolderFull = `${this.projectPathFull}/Library`;
    this.cacheFolderFull = `/${buildVolumeFolder}/${cacheFolder}/${this.branchName}`;
  }

  private static async SetupStep() {
    core.info('Starting step 1/4 clone and restore cache)');

    const lfsDirectory = `${this.repoPathFull}/.git/lfs`;
    const testLFSFile = `${this.projectPathFull}/Assets/LFS_Test_File.jpg`;

    const unityBuilderRepoUrl = `https://${this.buildParams.githubToken}@github.com/game-ci/unity-builder.git`;
    const steamDeployRepoUrl = `https://${this.buildParams.githubToken}@github.com/game-ci/steam-deploy.git`;
    const targetBuildRepoUrl = `https://${this.buildParams.githubToken}@github.com/${process.env.GITHUB_REPOSITORY}.git`;

    const purgeRemoteCache = process.env.PURGE_REMOTE_BUILDER_CACHE !== undefined;
    const initializeSourceRepoForCaching = `${this.builderPathFull}/dist/remote-builder/cloneNoLFS.sh "${this.repoPathFull}" "${targetBuildRepoUrl}" "${testLFSFile}"`;
    const handleCaching = `${this.builderPathFull}/dist/remote-builder/handleCaching.sh "${this.cacheFolderFull}" "${this.libraryFolderFull}" "${lfsDirectory}" "${purgeRemoteCache}"`;
    await this.RemoteBuilderProviderPlatform.runBuildTask(
      this.buildId,
      'alpine/git',
      [
        ` printenv
          #
          apk update -q
          apk add unzip zip git-lfs jq tree -q
          #
          mkdir -p ${this.buildPathFull}
          mkdir -p ${this.builderPathFull}
          mkdir -p ${this.repoPathFull}
          mkdir -p ${this.steamPathFull}
          #
          echo ' '
          echo 'Cloning utility repositories for remote builder'
          git clone -q --branch "remote-builder/unified-providers" ${unityBuilderRepoUrl} ${this.builderPathFull}
          echo 'Cloned ${unityBuilderRepoUrl}'
          git clone -q ${steamDeployRepoUrl} ${this.steamPathFull}
          echo 'Cloned ${steamDeployRepoUrl}'
          #
          echo ' '
          echo 'Initializing source repository for cloning with caching of LFS files'
          ${initializeSourceRepoForCaching}
          echo 'Source repository initialized'
          export LFS_ASSETS_HASH="$(cat ${this.repoPathFull}/.lfs-assets-id)"
          ${process.env.DEBUG ? '' : '#'}echo $LFS_ASSETS_HASH
          ${process.env.DEBUG ? '' : '#'}echo ' '
          ${process.env.DEBUG ? '' : '#'}echo 'Large File before LFS caching and pull'
          ${process.env.DEBUG ? '' : '#'}ls -alh "${lfsDirectory}"
          ${process.env.DEBUG ? '' : '#'}echo ' '
          echo ' '
          echo 'Starting checks of cache for the Unity project Library and git LFS files'
          ${handleCaching}
          ${process.env.DEBUG ? '' : '#'}echo 'Caching complete'
          ${process.env.DEBUG ? '' : '#'}echo ' '
          ${process.env.DEBUG ? '' : '#'}echo 'Large File after LFS caching and pull'
          ${process.env.DEBUG ? '' : '#'}ls -alh "${lfsDirectory}"
          echo ' '
          #
          ${process.env.DEBUG ? '' : '#'}tree -L 4 "${this.buildPathFull}"
          ${process.env.DEBUG ? '' : '#'}ls -lh "/${buildVolumeFolder}"
          echo ' '
          #
      `,
      ],
      `/${buildVolumeFolder}`,
      `/${buildVolumeFolder}/`,
      RemoteBuilder.defaultGitShaEnvironmentVariable,
      this.defaultSecrets,
    );
  }

  private static async BuildStep(baseImage: any) {
    core.info('Starting part 2/4 (build unity project)');
    await this.RemoteBuilderProviderPlatform.runBuildTask(
      this.buildId,
      baseImage.toString(),
      [
        `
            printenv
            export GITHUB_WORKSPACE="${this.projectPathFull}"
            cp -r "${this.builderPathFull}/dist/default-build-script/" "/UnityBuilderAction"
            cp -r "${this.builderPathFull}/dist/entrypoint.sh" "/entrypoint.sh"
            cp -r "${this.builderPathFull}/dist/steps/" "/steps"
            chmod -R +x "/entrypoint.sh"
            chmod -R +x "/steps"
            /entrypoint.sh
            ls -lh
          `,
      ],
      `/${buildVolumeFolder}`,
      `/${this.projectPathFull}`,
      RemoteBuilder.readBuildEnvironmentVariables(),
      this.defaultSecrets,
    );
  }

  private static async CompressionStep() {
    core.info('Starting step 3/4 build compression');
    // Cleanup
    await this.RemoteBuilderProviderPlatform.runBuildTask(
      this.buildId,
      'alpine',
      [
        `
            printenv
            apk update -q
            apk add zip -q
            cd "${this.libraryFolderFull}"
            zip -r "lib-${this.buildId}.zip" "${this.libraryFolderFull}"
            mv "lib-${this.buildId}.zip" "${this.cacheFolderFull}/lib"
            cd "${this.projectPathFull}"
            ls -lh "${this.projectPathFull}"
            zip -r "build-${this.buildId}.zip" "${this.projectPathFull}/${RemoteBuilder.buildParams.buildPath}"
            mv "build-${this.buildId}.zip" "/${buildVolumeFolder}/${this.buildId}/build-${this.buildId}.zip"
          `,
      ],
      `/${buildVolumeFolder}`,
      `/${buildVolumeFolder}`,
      [
        {
          name: 'GITHUB_SHA',
          value: process.env.GITHUB_SHA || '',
        },
      ],
      this.defaultSecrets,
    );
    core.info('compression step complete');
  }

  private static async UploadArtifacts() {
    core.info('Starting step 4/4 upload build to s3');
    await this.RemoteBuilderProviderPlatform.runBuildTask(
      this.buildId,
      'amazon/aws-cli',
      [
        `
            aws s3 cp ${this.buildId}/build-${this.buildId}.zip "s3://${this.buildParams.awsBaseStackName}-storage/"
            # no need to upload Library cache for now
            # aws s3 cp "/${buildVolumeFolder}/${cacheFolder}/$branch/lib-${this.buildId}.zip" "s3://${
          this.buildParams.awsBaseStackName
        }-storage/"
            ${this.SteamDeploy ? '#' : ''} rm -r ${this.buildId}
          `,
      ],
      `/${buildVolumeFolder}`,
      `/${buildVolumeFolder}/`,
      RemoteBuilder.readUploadArtifactEnvironmentVariables(),
      RemoteBuilder.readUploadArtifactsSecrets(),
    );
  }

  private static async DeployToSteam() {
    core.info('Starting steam deployment');
    await this.RemoteBuilderProviderPlatform.runBuildTask(
      this.buildId,
      'cm2network/steamcmd:root',
      [
        `
            ls
            ls /
            cp -r /${buildVolumeFolder}/${this.buildId}/steam/action/entrypoint.sh /entrypoint.sh;
            cp -r /${buildVolumeFolder}/${this.buildId}/steam/action/steps/ /steps;
            chmod -R +x /entrypoint.sh;
            chmod -R +x /steps;
            /entrypoint.sh;
            rm -r /${buildVolumeFolder}/${this.buildId}
          `,
      ],
      `/${buildVolumeFolder}`,
      `/${buildVolumeFolder}/${this.buildId}/steam/action/`,
      [
        {
          name: 'GITHUB_SHA',
          value: process.env.GITHUB_SHA || '',
        },
      ],
      RemoteBuilder.readDeployToSteamSecrets(),
    );
  }

  private static setupBuildPlatform() {
    switch (this.buildParams.remoteBuildCluster) {
      case 'aws':
        core.info('Building with AWS');
        this.RemoteBuilderProviderPlatform = new AWSBuildPlatform(this.buildParams);
        break;
      default:
      case 'k8s':
        core.info('Building with Kubernetes');
        this.RemoteBuilderProviderPlatform = new Kubernetes(this.buildParams);
        break;
    }
  }

  private static readRunNumber() {
    const runNumber = process.env.GITHUB_RUN_NUMBER;
    if (!runNumber || runNumber === '') {
      throw new Error('no run number found, exiting');
    }
    return runNumber;
  }

  private static setupBranchName() {
    const defaultBranchName =
      process.env.GITHUB_REF?.split('/')
        .filter((x) => {
          x = x[0].toUpperCase() + x.slice(1);
          return x;
        })
        .join('') || '';
    this.branchName =
      process.env.REMOTE_BUILDER_CACHE !== undefined ? process.env.REMOTE_BUILDER_CACHE : defaultBranchName;
  }

  private static setupDefaultSecrets() {
    this.defaultSecrets = [
      {
        ParameterKey: 'GithubToken',
        EnvironmentVariable: 'GITHUB_TOKEN',
        ParameterValue: this.buildParams.githubToken,
      },
      {
        ParameterKey: 'branch',
        EnvironmentVariable: 'branch',
        ParameterValue: this.branchName,
      },
      {
        ParameterKey: 'buildPathFull',
        EnvironmentVariable: 'buildPathFull',
        ParameterValue: this.buildPathFull,
      },
      {
        ParameterKey: 'projectPathFull',
        EnvironmentVariable: 'projectPathFull',
        ParameterValue: this.projectPathFull,
      },
      {
        ParameterKey: 'libraryFolderFull',
        EnvironmentVariable: 'libraryFolderFull',
        ParameterValue: this.libraryFolderFull,
      },
      {
        ParameterKey: 'builderPathFull',
        EnvironmentVariable: 'builderPathFull',
        ParameterValue: this.builderPathFull,
      },
      {
        ParameterKey: 'repoPathFull',
        EnvironmentVariable: 'repoPathFull',
        ParameterValue: this.repoPathFull,
      },
      {
        ParameterKey: 'steamPathFull',
        EnvironmentVariable: 'steamPathFull',
        ParameterValue: this.steamPathFull,
      },
    ];
    this.defaultSecrets.push(
      ...ImageEnvironmentFactory.getEnvironmentVariables(this.buildParams).map((x) => {
        return {
          ParameterKey: x.name,
          EnvironmentVariable: x.name,
          ParameterValue: x.value,
        };
      }),
    );
  }

  private static readUploadArtifactsSecrets() {
    return [
      {
        ParameterKey: 'AWSAccessKeyID',
        EnvironmentVariable: 'AWS_ACCESS_KEY_ID',
        ParameterValue: process.env.AWS_ACCESS_KEY_ID || '',
      },
      {
        ParameterKey: 'AWSSecretAccessKey',
        EnvironmentVariable: 'AWS_SECRET_ACCESS_KEY',
        ParameterValue: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
      ...this.defaultSecrets,
    ];
  }

  private static readDeployToSteamSecrets(): RemoteBuilderSecret[] {
    return [
      {
        EnvironmentVariable: 'INPUT_APPID',
        ParameterKey: 'appId',
        ParameterValue: process.env.APP_ID || '',
      },
      {
        EnvironmentVariable: 'INPUT_BUILDDESCRIPTION',
        ParameterKey: 'buildDescription',
        ParameterValue: process.env.BUILD_DESCRIPTION || '',
      },
      {
        EnvironmentVariable: 'INPUT_ROOTPATH',
        ParameterKey: 'rootPath',
        ParameterValue: RemoteBuilder.buildParams.buildPath,
      },
      {
        EnvironmentVariable: 'INPUT_RELEASEBRANCH',
        ParameterKey: 'releaseBranch',
        ParameterValue: process.env.RELEASE_BRANCH || '',
      },
      {
        EnvironmentVariable: 'INPUT_LOCALCONTENTSERVER',
        ParameterKey: 'localContentServer',
        ParameterValue: process.env.LOCAL_CONTENT_SERVER || '',
      },
      {
        EnvironmentVariable: 'INPUT_PREVIEWENABLED',
        ParameterKey: 'previewEnabled',
        ParameterValue: process.env.PREVIEW_ENABLED || '',
      },
      ...this.defaultSecrets,
    ];
  }

  private static readBuildEnvironmentVariables(): RemoteBuilderEnvironmentVariable[] {
    return [
      {
        name: 'ContainerMemory',
        value: this.buildParams.remoteBuildMemory,
      },
      {
        name: 'ContainerCpu',
        value: this.buildParams.remoteBuildCpu,
      },
      {
        name: 'GITHUB_WORKSPACE',
        value: `/${buildVolumeFolder}/${this.buildId}/${repositoryFolder}/`,
      },
      {
        name: 'PROJECT_PATH',
        value: this.buildParams.projectPath,
      },
      {
        name: 'BUILD_PATH',
        value: this.buildParams.buildPath,
      },
      {
        name: 'BUILD_FILE',
        value: this.buildParams.buildFile,
      },
      {
        name: 'BUILD_NAME',
        value: this.buildParams.buildName,
      },
      {
        name: 'BUILD_METHOD',
        value: this.buildParams.buildMethod,
      },
      {
        name: 'CUSTOM_PARAMETERS',
        value: this.buildParams.customParameters,
      },
      {
        name: 'BUILD_TARGET',
        value: this.buildParams.platform,
      },
      {
        name: 'ANDROID_VERSION_CODE',
        value: this.buildParams.androidVersionCode.toString(),
      },
      {
        name: 'ANDROID_KEYSTORE_NAME',
        value: this.buildParams.androidKeystoreName,
      },
      {
        name: 'ANDROID_KEYALIAS_NAME',
        value: this.buildParams.androidKeyaliasName,
      },
    ];
  }

  private static readUploadArtifactEnvironmentVariables() {
    return [
      {
        name: 'GITHUB_SHA',
        value: process.env.GITHUB_SHA || '',
      },
      {
        name: 'AWS_DEFAULT_REGION',
        value: process.env.AWS_DEFAULT_REGION || '',
      },
    ];
  }

  private static async handleException(error: unknown) {
    core.error(JSON.stringify(error, undefined, 4));
    core.setFailed('Remote Builder failed');
    await this.RemoteBuilderProviderPlatform.cleanupSharedBuildResources(
      this.buildId,
      this.buildParams,
      this.branchName,
      this.defaultSecrets,
    );
  }
}
export default RemoteBuilder;
