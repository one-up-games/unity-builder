// @ts-ignore
import * as k8s from '@kubernetes/client-node';
import { BuildParameters } from '.';
const core = require('@actions/core');
const base64 = require('base-64');

const pollInterval = 10000;

class Kubernetes {
  private static kubeClient: k8s.CoreV1Api;
  private static kubeClientBatch: k8s.BatchV1Api;
  private static buildId: string;
  private static buildParameters: BuildParameters;
  private static baseImage: any;
  private static pvcName: string;
  private static secretName: string;
  private static jobName: string;
  private static namespace: string;

  static async runBuildJob(buildParameters: BuildParameters, baseImage) {
    core.info('Starting up k8s');
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
    const k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api);
    core.info('loaded from default');

    // const kubeconfig = new KubeConfig();
    // kubeconfig.loadFromString(base64.decode(buildParameters.kubeConfig));
    // const backend = new Request({ kubeconfig });
    // const kubeClient = new Client(backend);
    // await kubeClient.loadSpec();

    const buildId = Kubernetes.uuidv4();
    const pvcName = `unity-builder-pvc-${buildId}`;
    const secretName = `build-credentials-${buildId}`;
    const jobName = `unity-builder-job-${buildId}`;
    const namespace = 'default';

    this.kubeClient = k8sApi;
    this.kubeClientBatch = k8sBatchApi;
    this.buildId = buildId;
    this.buildParameters = buildParameters;
    this.baseImage = baseImage;
    this.pvcName = pvcName;
    this.secretName = secretName;
    this.jobName = jobName;
    this.namespace = namespace;

    // setup
    await Kubernetes.createSecret();
    await Kubernetes.createPersistentVolumeClaim();

    // start
    await Kubernetes.scheduleBuildJob();

    // watch
    await Kubernetes.watchPersistentVolumeClaimUntilReady();
    await Kubernetes.watchBuildJobUntilFinished();

    // cleanup
    await Kubernetes.cleanup();

    core.setOutput('volume', pvcName);
  }

  static async createSecret() {
    const secret = new k8s.V1Secret();
    secret.apiVersion = 'v1';
    secret.kind = 'Secret';
    secret.type = 'Opaque';
    secret.metadata = {
      name: this.secretName,
    };

    secret.data = {
      GITHUB_TOKEN: base64.encode(this.buildParameters.githubToken),
      UNITY_LICENSE: base64.encode(process.env.UNITY_LICENSE),
      ANDROID_KEYSTORE_BASE64: base64.encode(this.buildParameters.androidKeystoreBase64),
      ANDROID_KEYSTORE_PASS: base64.encode(this.buildParameters.androidKeystorePass),
      ANDROID_KEYALIAS_PASS: base64.encode(this.buildParameters.androidKeyaliasPass),
    };

    await this.kubeClient.createNamespacedSecret(this.namespace, secret);
  }

  static async createPersistentVolumeClaim() {
    if (this.buildParameters.kubeVolume) {
      core.info(this.buildParameters.kubeVolume);
      this.pvcName = this.buildParameters.kubeVolume;
      return;
    }
    const pvc = new k8s.V1PersistentVolumeClaim();
    pvc.apiVersion = 'v1';
    pvc.kind = 'PersistentVolumeClaim';
    pvc.metadata = {
      name: this.pvcName,
    };
    pvc.spec = {
      accessModes: ['ReadWriteOnce'],
      volumeMode: 'Filesystem',
      resources: {
        requests: {
          storage: this.buildParameters.kubeVolumeSize,
        },
      },
    };
    await this.kubeClient.createNamespacedPersistentVolumeClaim(this.namespace, pvc);
    core.info('Persistent Volume created, waiting for ready state...');
  }

  static async watchPersistentVolumeClaimUntilReady() {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    const queryResult = await this.kubeClient.readNamespacedPersistentVolumeClaim(this.pvcName, this.namespace);

    if (queryResult.body.status?.phase === 'Pending') {
      await Kubernetes.watchPersistentVolumeClaimUntilReady();
    } else {
      core.info('Persistent Volume ready for claims');
    }
  }

  static async scheduleBuildJob() {
    core.info('Creating build job');
    const job = new k8s.V1Job();
    job.apiVersion = 'batch/v1';
    job.kind = 'Job';
    job.metadata = {
      name: this.jobName,
      labels: {
        app: 'unity-builder',
      },
    };
    job.spec = {
      template: {
        spec: {
          volumes: [
            {
              name: 'data',
              persistentVolumeClaim: {
                claimName: this.pvcName,
              },
            },
            {
              name: 'credentials',
              secret: {
                secretName: this.secretName,
              },
            },
          ],
          initContainers: [
            {
              name: 'clone',
              image: 'alpine/git',
              command: [
                '/bin/sh',
                '-c',
                `apk update;
                apk add git-lfs;
                export GITHUB_TOKEN=$(cat /credentials/GITHUB_TOKEN);
                cd /data;
                git clone https://github.com/${process.env.GITHUB_REPOSITORY}.git repo;
                git clone https://github.com/webbertakken/unity-builder.git builder;
                cd repo;
                git checkout $GITHUB_SHA;
                ls`,
              ],
              volumeMounts: [
                {
                  name: 'data',
                  mountPath: '/data',
                },
                {
                  name: 'credentials',
                  mountPath: '/credentials',
                  readOnly: true,
                },
              ],
              env: [
                {
                  name: 'GITHUB_SHA',
                  value: this.buildId,
                },
              ],
            },
          ],
          containers: [
            {
              name: 'main',
              image: `${this.baseImage.toString()}`,
              command: [
                'bin/bash',
                '-c',
                `ls
                for f in ./credentials/*; do export $(basename $f)="$(cat $f)"; done
                ls /data
                ls /data/builder
                ls /data/builder/dist
                cp -r /data/builder/dist/default-build-script /UnityBuilderAction
                cp -r /data/builder/dist/entrypoint.sh /entrypoint.sh
                cp -r /data/builder/dist/steps /steps
                chmod -R +x /entrypoint.sh
                chmod -R +x /steps
                /entrypoint.sh
                `,
              ],
              resources: {
                requests: {
                  memory: this.buildParameters.remoteBuildMemory,
                  cpu: this.buildParameters.remoteBuildCpu,
                },
              },
              env: [
                {
                  name: 'GITHUB_WORKSPACE',
                  value: '/data/repo',
                },
                {
                  name: 'PROJECT_PATH',
                  value: this.buildParameters.projectPath,
                },
                {
                  name: 'BUILD_PATH',
                  value: this.buildParameters.buildPath,
                },
                {
                  name: 'BUILD_FILE',
                  value: this.buildParameters.buildFile,
                },
                {
                  name: 'BUILD_NAME',
                  value: this.buildParameters.buildName,
                },
                {
                  name: 'BUILD_METHOD',
                  value: this.buildParameters.buildMethod,
                },
                {
                  name: 'CUSTOM_PARAMETERS',
                  value: this.buildParameters.customParameters,
                },
                {
                  name: 'CHOWN_FILES_TO',
                  value: this.buildParameters.chownFilesTo,
                },
                {
                  name: 'BUILD_TARGET',
                  value: this.buildParameters.platform,
                },
                {
                  name: 'ANDROID_VERSION_CODE',
                  value: this.buildParameters.androidVersionCode.toString(),
                },
                {
                  name: 'ANDROID_KEYSTORE_NAME',
                  value: this.buildParameters.androidKeystoreName,
                },
                {
                  name: 'ANDROID_KEYALIAS_NAME',
                  value: this.buildParameters.androidKeyaliasName,
                },
              ],
              volumeMounts: [
                {
                  name: 'data',
                  mountPath: '/data',
                },
                {
                  name: 'credentials',
                  mountPath: '/credentials',
                  readOnly: true,
                },
              ],
              lifecycle: {
                preStop: {
                  exec: {
                    command: [
                      'bin/bash',
                      '-c',
                      `cd /data/builder/action/steps;
                      chmod +x /return_license.sh;
                      /return_license.sh;`,
                    ],
                  },
                },
              },
            },
          ],
          restartPolicy: 'Never',
        },
      },
    };
    job.spec.backoffLimit = 1;
    await this.kubeClientBatch.createNamespacedJob(this.namespace, job);
    core.info('Job created');
  }

  static async watchPodUntilReadyAndRead(statusFilter: string) {
    let ready = false;

    while (!ready) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      const pods = await this.kubeClient.listNamespacedPod(this.namespace);
      for (let index = 0; index < pods.body.items.length; index++) {
        const element = pods.body.items[index];
        const jobname = element.metadata?.labels?.['job-name'];
        const phase = element.status?.phase;
        if (jobname === this.jobName && phase !== statusFilter) {
          core.info('Pod no longer pending');
          if (phase === 'Failure') {
            core.error('Kubernetes job failed');
          } else {
            ready = true;
            return element;
          }
        }
      }
    }
  }

  static async watchBuildJobUntilFinished() {
    const pod = (await Kubernetes.watchPodUntilReadyAndRead('Pending')) || {};

    core.info(
      `Watching build job ${pod.metadata?.name} ${JSON.stringify(
        pod.status?.containerStatuses?.[0].state,
        undefined,
        4,
      )}`,
    );
    await Kubernetes.streamLogs(pod.metadata?.name || '', this.namespace);
  }

  static async streamLogs(name: string, namespace: string) {
    let running = true;
    let logQueryTime;
    while (running) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      const logs = await this.kubeClient.readNamespacedPodLog(
        name,
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        logQueryTime,
        undefined,
        true,
      );
      core.info(logs.body);
      const arrayOfLines = logs.body.match(/[^\n\r]+/g)?.reverse();
      if (arrayOfLines) {
        for (const element of arrayOfLines) {
          const [time, ...line] = element.split(' ');
          if (time !== logQueryTime) {
            core.info(line.join(' '));
          } else {
            break;
          }
        }
        logQueryTime = arrayOfLines[0].split(' ')[0];
      }
      const pod = await this.kubeClient.readNamespacedPod(name, namespace);
      running = pod.body.status?.phase === 'Running';
    }
  }

  static async cleanup() {
    await this.kubeClientBatch.deleteNamespacedJob(this.jobName, this.namespace);
    await this.kubeClient.deleteNamespacedSecret(this.secretName, this.namespace);
  }

  static uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.trunc(Math.random() * 16);
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
export default Kubernetes;
