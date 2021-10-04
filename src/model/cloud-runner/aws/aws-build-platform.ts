import * as SDK from 'aws-sdk';
import { customAlphabet } from 'nanoid';
import CloudRunnerSecret from '../cloud-runner-services/cloud-runner-secret';
import CloudRunnerEnvironmentVariable from '../cloud-runner-services/cloud-runner-environment-variable';
import * as fs from 'fs';
import * as core from '@actions/core';
import CloudRunnerTaskDef from '../cloud-runner-services/cloud-runner-task-def';
import CloudRunnerConstants from '../cloud-runner-services/cloud-runner-constants';
import AWSBuildRunner from './aws-build-runner';
import { CloudRunnerProviderInterface } from '../cloud-runner-services/cloud-runner-provider-interface';
import BuildParameters from '../../build-parameters';
import CloudRunnerLogger from '../cloud-runner-services/cloud-runner-logger';
const crypto = require('crypto');

class AWSBuildEnvironment implements CloudRunnerProviderInterface {
  private baseStackName: string;

  constructor(buildParameters: BuildParameters) {
    this.baseStackName = buildParameters.awsBaseStackName;
  }
  cleanupSharedBuildResources(
    // eslint-disable-next-line no-unused-vars
    buildGuid: string,
    // eslint-disable-next-line no-unused-vars
    buildParameters: BuildParameters,
    // eslint-disable-next-line no-unused-vars
    branchName: string,
    // eslint-disable-next-line no-unused-vars
    defaultSecretsArray: { ParameterKey: string; EnvironmentVariable: string; ParameterValue: string }[],
  ) {}
  setupSharedBuildResources(
    // eslint-disable-next-line no-unused-vars
    buildGuid: string,
    // eslint-disable-next-line no-unused-vars
    buildParameters: BuildParameters,
    // eslint-disable-next-line no-unused-vars
    branchName: string,
    // eslint-disable-next-line no-unused-vars
    defaultSecretsArray: { ParameterKey: string; EnvironmentVariable: string; ParameterValue: string }[],
  ) {}

  async runBuildTask(
    buildId: string,
    image: string,
    commands: string[],
    mountdir: string,
    workingdir: string,
    environment: CloudRunnerEnvironmentVariable[],
    secrets: CloudRunnerSecret[],
  ): Promise<void> {
    const ECS = new SDK.ECS();
    const CF = new SDK.CloudFormation();
    const entrypoint = ['/bin/sh'];
    const t0 = Date.now();
    const taskDef = await this.setupCloudFormations(
      CF,
      buildId,
      image,
      entrypoint,
      commands,
      mountdir,
      workingdir,
      secrets,
    );

    let t2;
    try {
      const t1 = Date.now();
      CloudRunnerLogger.log(`Setup job time: ${Math.floor((t1 - t0) / 1000)}s`);
      await AWSBuildRunner.runTask(taskDef, ECS, CF, environment, buildId, commands);
      t2 = Date.now();
      CloudRunnerLogger.log(`Run job time: ${Math.floor((t2 - t1) / 1000)}s`);
    } finally {
      await this.cleanupResources(CF, taskDef);
      const t3 = Date.now();
      if (t2 !== undefined) CloudRunnerLogger.log(`Cleanup job time: ${Math.floor((t3 - t2) / 1000)}s`);
    }
  }

  getParameterTemplate(p1) {
    return `
  ${p1}:
    Type: String
    Default: ''
`;
  }

  getSecretTemplate(p1) {
    return `
  ${p1}Secret:
    Type: AWS::SecretsManager::Secret
    Properties:
      Name: !Join [ "", [ '${p1}', !Ref BUILDID ] ]
      SecretString: !Ref ${p1}
`;
  }

  getSecretDefinitionTemplate(p1, p2) {
    return `
            - Name: '${p1}'
              ValueFrom: !Ref ${p2}Secret
`;
  }

  insertAtTemplate(template, insertionKey, insertion) {
    const index = template.search(insertionKey) + insertionKey.length + '\n'.length;
    template = [template.slice(0, index), insertion, template.slice(index)].join('');
    return template;
  }

  async setupCloudFormations(
    CF: SDK.CloudFormation,
    buildGuid: string,
    image: string,
    entrypoint: string[],
    commands: string[],
    mountdir: string,
    workingdir: string,
    secrets: CloudRunnerSecret[],
  ): Promise<CloudRunnerTaskDef> {
    const logGuid = customAlphabet(CloudRunnerConstants.alphabet, 9)();
    commands[1] += `
      echo "${logGuid}"
    `;
    await this.setupBaseStack(CF);
    const taskDefStackName = `${this.baseStackName}-${buildGuid}`;
    let taskDefCloudFormation = this.readTaskCloudFormationTemplate();
    const cleanupTaskDefStackName = `${taskDefStackName}-cleanup`;
    const cleanupCloudFormation = fs.readFileSync(`${__dirname}/cloud-formations/cloudformation-stack-ttl.yml`, 'utf8');

    for (const secret of secrets) {
      if (typeof secret.ParameterValue == 'number') {
        secret.ParameterValue = `${secret.ParameterValue}`;
      }
      if (!secret.ParameterValue || secret.ParameterValue === '') {
        secrets = secrets.filter((x) => x !== secret);
        continue;
      }
      taskDefCloudFormation = this.insertAtTemplate(
        taskDefCloudFormation,
        'p1 - input',
        this.getParameterTemplate(secret.ParameterKey.replace(/[^\dA-Za-z]/g, '')),
      );
      taskDefCloudFormation = this.insertAtTemplate(
        taskDefCloudFormation,
        'p2 - secret',
        this.getSecretTemplate(secret.ParameterKey.replace(/[^\dA-Za-z]/g, '')),
      );
      taskDefCloudFormation = this.insertAtTemplate(
        taskDefCloudFormation,
        'p3 - container def',
        this.getSecretDefinitionTemplate(secret.EnvironmentVariable, secret.ParameterKey.replace(/[^\dA-Za-z]/g, '')),
      );
    }
    const secretsMappedToCloudFormationParameters = secrets.map((x) => {
      return { ParameterKey: x.ParameterKey.replace(/[^\dA-Za-z]/g, ''), ParameterValue: x.ParameterValue };
    });
    const parameters = [
      {
        ParameterKey: 'EnvironmentName',
        ParameterValue: this.baseStackName,
      },
      {
        ParameterKey: 'ImageUrl',
        ParameterValue: image,
      },
      {
        ParameterKey: 'ServiceName',
        ParameterValue: taskDefStackName,
      },
      {
        ParameterKey: 'Command',
        ParameterValue: 'echo "this template should be overwritten when running a task"',
      },
      {
        ParameterKey: 'EntryPoint',
        ParameterValue: entrypoint.join(','),
      },
      {
        ParameterKey: 'WorkingDirectory',
        ParameterValue: workingdir,
      },
      {
        ParameterKey: 'EFSMountDirectory',
        ParameterValue: mountdir,
      },
      {
        ParameterKey: 'BUILDID',
        ParameterValue: buildGuid,
      },
      ...secretsMappedToCloudFormationParameters,
    ];

    try {
      await CF.createStack({
        StackName: taskDefStackName,
        TemplateBody: taskDefCloudFormation,
        Capabilities: ['CAPABILITY_IAM'],
        Parameters: parameters,
      }).promise();
      CloudRunnerLogger.log('Creating cloud runner job');
      await CF.createStack({
        StackName: cleanupTaskDefStackName,
        TemplateBody: cleanupCloudFormation,
        Capabilities: ['CAPABILITY_IAM'],
        Parameters: [
          {
            ParameterKey: 'StackName',
            ParameterValue: taskDefStackName,
          },
          {
            ParameterKey: 'DeleteStackName',
            ParameterValue: cleanupTaskDefStackName,
          },
          {
            ParameterKey: 'TTL',
            ParameterValue: '100',
          },
          {
            ParameterKey: 'BUILDID',
            ParameterValue: buildGuid,
          },
          {
            ParameterKey: 'EnvironmentName',
            ParameterValue: this.baseStackName,
          },
        ],
      }).promise();
      await CF.waitFor('stackCreateComplete', { StackName: taskDefStackName }).promise();
    } catch (error) {
      await this.handleStackCreationFailure(error, CF, taskDefStackName, taskDefCloudFormation, parameters, secrets);
      throw error;
    }

    const taskDefResources = (
      await CF.describeStackResources({
        StackName: taskDefStackName,
      }).promise()
    ).StackResources;

    const baseResources = (await CF.describeStackResources({ StackName: this.baseStackName }).promise()).StackResources;

    // TODO: offer a parameter to decide if you want the guaranteed shutdown or fastest startup time possible

    return {
      taskDefStackName,
      taskDefCloudFormation,
      taskDefStackNameTTL: cleanupTaskDefStackName,
      ttlCloudFormation: cleanupCloudFormation,
      taskDefResources,
      baseResources,
      logid: logGuid,
    };
  }

  async setupBaseStack(CF: SDK.CloudFormation) {
    const baseStackName = this.baseStackName;
    const baseStack = fs.readFileSync(`${__dirname}/cloud-formations/base-setup.yml`, 'utf8');

    // Cloud Formation Input
    const describeStackInput: SDK.CloudFormation.DescribeStacksInput = {
      StackName: baseStackName,
    };
    const parametersWithoutHash: SDK.CloudFormation.Parameter[] = [
      { ParameterKey: 'EnvironmentName', ParameterValue: baseStackName },
      { ParameterKey: 'Storage', ParameterValue: `${baseStackName}-storage` },
    ];
    const hash = crypto
      .createHash('md5')
      .update(baseStack + JSON.stringify(parametersWithoutHash))
      .digest('hex');
    const parameters: SDK.CloudFormation.Parameter[] = [
      ...parametersWithoutHash,
      ...[{ ParameterKey: 'Version', ParameterValue: hash }],
    ];
    const updateInput: SDK.CloudFormation.UpdateStackInput = {
      StackName: baseStackName,
      TemplateBody: baseStack,
      Parameters: parameters,
      Capabilities: ['CAPABILITY_IAM'],
    };
    const createStackInput: SDK.CloudFormation.CreateStackInput = {
      StackName: baseStackName,
      TemplateBody: baseStack,
      Parameters: parameters,
      Capabilities: ['CAPABILITY_IAM'],
    };

    const stacks = (
      await CF.listStacks({ StackStatusFilter: ['UPDATE_COMPLETE', 'CREATE_COMPLETE'] }).promise()
    ).StackSummaries?.map((x) => x.StackName);
    const stackExists: Boolean = stacks?.includes(baseStackName) || false;
    const describeStack = async () => {
      return await CF.describeStacks(describeStackInput).promise();
    };
    try {
      if (!stackExists) {
        CloudRunnerLogger.log(`${baseStackName} stack does not exist (${JSON.stringify(stacks)})`);
        await CF.createStack(createStackInput).promise();
        CloudRunnerLogger.log(`created stack (version: ${hash})`);
      }
      const CFState = await describeStack();
      let stack = CFState.Stacks?.[0];
      if (!stack) {
        throw new Error(`Base stack doesn't exist, even after creation, stackExists check: ${stackExists}`);
      }
      const stackVersion = stack.Parameters?.find((x) => x.ParameterKey === 'Version')?.ParameterValue;

      if (stack.StackStatus === 'CREATE_IN_PROGRESS') {
        await CF.waitFor('stackCreateComplete', describeStackInput).promise();
      }

      if (stackExists) {
        CloudRunnerLogger.log(`Base stack exists (version: ${stackVersion}, local version: ${hash})`);
        if (hash !== stackVersion) {
          CloudRunnerLogger.log(`Updating`);
          await CF.updateStack(updateInput).promise();
        } else {
          CloudRunnerLogger.log(`No update required`);
        }
        stack = (await describeStack()).Stacks?.[0];
        if (!stack) {
          throw new Error(
            `Base stack doesn't exist, even after updating and creation, stackExists check: ${stackExists}`,
          );
        }
        if (stack.StackStatus === 'UPDATE_IN_PROGRESS') {
          await CF.waitFor('stackUpdateComplete', describeStackInput).promise();
        }
      }
      CloudRunnerLogger.log('base stack is ready');
    } catch (error) {
      core.error(JSON.stringify(await describeStack(), undefined, 4));
      throw error;
    }
  }

  async handleStackCreationFailure(
    error: any,
    CF: SDK.CloudFormation,
    taskDefStackName: string,
    taskDefCloudFormation: string,
    parameters: any[],
    secrets: CloudRunnerSecret[],
  ) {
    CloudRunnerLogger.log('aws stack parameters: ');
    CloudRunnerLogger.log(JSON.stringify(parameters, undefined, 4));

    CloudRunnerLogger.log('aws stack secrets: ');
    CloudRunnerLogger.log(JSON.stringify(secrets, undefined, 4));

    CloudRunnerLogger.log('aws stack: ');
    CloudRunnerLogger.log(taskDefCloudFormation);

    CloudRunnerLogger.log('aws error: ');
    core.error(error);
    CloudRunnerLogger.log('Getting events and resources for task stack');
    const events = (await CF.describeStackEvents({ StackName: taskDefStackName }).promise()).StackEvents;
    const resources = (await CF.describeStackResources({ StackName: taskDefStackName }).promise()).StackResources;
    CloudRunnerLogger.log(JSON.stringify(events, undefined, 4));
    CloudRunnerLogger.log(JSON.stringify(resources, undefined, 4));
  }

  readTaskCloudFormationTemplate(): string {
    return fs.readFileSync(`${__dirname}/cloud-formations/task-def-formation.yml`, 'utf8');
  }

  async cleanupResources(CF: SDK.CloudFormation, taskDef: CloudRunnerTaskDef) {
    CloudRunnerLogger.log('Cleanup starting');
    await CF.deleteStack({
      StackName: taskDef.taskDefStackName,
    }).promise();
    await CF.deleteStack({
      StackName: taskDef.taskDefStackNameTTL,
    }).promise();

    await CF.waitFor('stackDeleteComplete', {
      StackName: taskDef.taskDefStackName,
    }).promise();
    await CF.waitFor('stackDeleteComplete', {
      StackName: taskDef.taskDefStackNameTTL,
    }).promise();

    const stacks = (await CF.listStacks().promise()).StackSummaries?.filter((x) => x.StackStatus !== 'DELETE_COMPLETE');

    CloudRunnerLogger.log(`Deleted Stacks: ${taskDef.taskDefStackName}, ${taskDef.taskDefStackNameTTL}`);
    CloudRunnerLogger.log(`Stacks: ${JSON.stringify(stacks, undefined, 4)}`);

    CloudRunnerLogger.log('Cleanup complete');
  }
}
export default AWSBuildEnvironment;
