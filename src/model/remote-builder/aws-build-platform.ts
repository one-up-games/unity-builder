import * as SDK from 'aws-sdk';
import { customAlphabet } from 'nanoid';
import RemoteBuilderSecret from './remote-builder-secret';
import RemoteBuilderEnvironmentVariable from './remote-builder-environment-variable';
import * as fs from 'fs';
import * as core from '@actions/core';
import RemoteBuilderTaskDef from './remote-builder-task-def';
import RemoteBuilderConstants from './remote-builder-constants';
import AWSBuildRunner from './aws-build-runner';
import { RemoteBuilderProviderInterface } from './remote-builder-provider-interface';
import BuildParameters from '../build-parameters';
const crypto = require('crypto');

class AWSBuildEnvironment implements RemoteBuilderProviderInterface {
  private stackName: string;

  constructor(buildParameters: BuildParameters) {
    this.stackName = buildParameters.awsStackName;
  }
  cleanupSharedBuildResources(
    // eslint-disable-next-line no-unused-vars
    buildUid: string,
    // eslint-disable-next-line no-unused-vars
    buildParameters: BuildParameters,
    // eslint-disable-next-line no-unused-vars
    branchName: string,
    // eslint-disable-next-line no-unused-vars
    defaultSecretsArray: { ParameterKey: string; EnvironmentVariable: string; ParameterValue: string }[],
  ) {}
  setupSharedBuildResources(
    // eslint-disable-next-line no-unused-vars
    buildUid: string,
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
    environment: RemoteBuilderEnvironmentVariable[],
    secrets: RemoteBuilderSecret[],
  ): Promise<void> {
    const ECS = new SDK.ECS();
    const CF = new SDK.CloudFormation();
    const entrypoint = ['/bin/sh'];

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
    try {
      await AWSBuildRunner.runTask(taskDef, ECS, CF, environment, buildId, commands);
    } finally {
      await this.cleanupResources(CF, taskDef);
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
    buildUid: string,
    image: string,
    entrypoint: string[],
    commands: string[],
    mountdir: string,
    workingdir: string,
    secrets: RemoteBuilderSecret[],
  ): Promise<RemoteBuilderTaskDef> {
    const logid = customAlphabet(RemoteBuilderConstants.alphabet, 9)();
    commands[1] += `
      echo "${logid}"
    `;
    await this.setupBaseStack(CF);
    const taskDefStackName = `${this.stackName}-${buildUid}`;
    let taskDefCloudFormation = this.readTaskCloudFormationTemplate();
    const cleanupTaskDefStackName = `${taskDefStackName}-cleanup`;
    const cleanupCloudFormation = fs.readFileSync(`${__dirname}/cloud-formations/cloudformation-stack-ttl.yml`, 'utf8');

    try {
      for (const secret of secrets) {
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
      const mappedSecrets = secrets.map((x) => {
        return { ParameterKey: x.ParameterKey.replace(/[^\dA-Za-z]/g, ''), ParameterValue: x.ParameterValue };
      });

      await CF.createStack({
        StackName: taskDefStackName,
        TemplateBody: taskDefCloudFormation,
        Parameters: [
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
            ParameterValue: buildUid,
          },
          ...mappedSecrets,
        ],
      }).promise();
      core.info('Creating main job...');
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
            ParameterValue: buildUid,
          },
        ],
      }).promise();
      core.info('Creating cleanup double checker cron job...');

      await CF.waitFor('stackCreateComplete', { StackName: taskDefStackName }).promise();
    } catch (error) {
      await this.handleStackCreationFailure(error, CF, taskDefStackName, taskDefCloudFormation, secrets);

      throw error;
    }

    const taskDefResources = (
      await CF.describeStackResources({
        StackName: taskDefStackName,
      }).promise()
    ).StackResources;

    const baseResources = (await CF.describeStackResources({ StackName: this.stackName }).promise()).StackResources;

    // TODO: offer a parameter to decide if you want the guarenteed shutdown or fastest startup time possible

    return {
      taskDefStackName,
      taskDefCloudFormation,
      taskDefStackNameTTL: cleanupTaskDefStackName,
      ttlCloudFormation: cleanupCloudFormation,
      taskDefResources,
      baseResources,
      logid,
    };
  }

  async setupBaseStack(CF: SDK.CloudFormation) {
    const baseStackName = process.env.baseStackName || 'game-ci-base-stack-01';
    const baseStack = fs.readFileSync(`${__dirname}/cloud-formations/base-setup.yml`, 'utf8');
    const hash = crypto.createHash('md5').update(baseStack).digest('hex');
    const describeStackInput: SDK.CloudFormation.DescribeStacksInput = {
      StackName: baseStackName,
    };
    const stacks = (await CF.listStacks().promise()).StackSummaries?.map((x) => x.StackName);
    const stackExists: Boolean = stacks?.includes(baseStackName) || false;

    if (!stackExists) {
      core.info('stack does not exist');
      await CF.createStack({
        StackName: baseStackName,
        TemplateBody: baseStack,
        Parameters: [
          { ParameterKey: 'EnvironmentName', ParameterValue: 'development' },
          { ParameterKey: 'Storage', ParameterValue: `${baseStackName}-storage` },
          { ParameterKey: 'Version', ParameterValue: `hash` },
        ],
      }).promise();
      core.info('created stack');
    }
    const CFState = await CF.describeStacks(describeStackInput).promise();
    let stack = CFState.Stacks?.[0];
    if (!stack) {
      throw new Error(`Base stack doesn't exist, even after creation, stackExists check: ${stackExists}`);
    }

    if (stack.StackStatus === 'CREATE_IN_PROGRESS') {
      await CF.waitFor('stackCreateComplete', describeStackInput).promise();
    }

    if (stackExists) {
      core.info('stack exists');
      if (
        stack.StackName === baseStackName &&
        hash !== stack.Parameters?.find((x) => x.ParameterKey === 'Version')?.ParameterValue
      ) {
        const updateInput: SDK.CloudFormation.UpdateStackInput = {
          StackName: baseStackName,
          TemplateBody: baseStack,
        };
        await CF.updateStack(updateInput).promise();
      } else {
        core.info(
          `Skipping any update for base stack ${stack.StackName} ${stack.Parameters?.find(
            (x) => x.ParameterKey === 'Version',
          )}`,
        );
      }
      stack = (await CF.describeStacks(describeStackInput).promise()).Stacks?.[0];
      if (!stack) {
        throw new Error(
          `Base stack doesn't exist, even after updating and creation, stackExists check: ${stackExists}`,
        );
      }
      if (stack.StackStatus === 'UPDATE_IN_PROGRESS') {
        await CF.waitFor('stackUpdateComplete', describeStackInput).promise();
      }
    }
    core.info('base stack exists and is ready');
  }

  async handleStackCreationFailure(
    error: any,
    CF: SDK.CloudFormation,
    taskDefStackName: string,
    taskDefCloudFormation: string,
    secrets: RemoteBuilderSecret[],
  ) {
    core.info(JSON.stringify(secrets, undefined, 4));
    core.info(taskDefCloudFormation);
    const events = (await CF.describeStackEvents({ StackName: taskDefStackName }).promise()).StackEvents;
    const resources = (await CF.describeStackResources({ StackName: taskDefStackName }).promise()).StackResources;
    core.info(JSON.stringify(events, undefined, 4));
    core.info(JSON.stringify(resources, undefined, 4));
    core.error(error);
  }

  readTaskCloudFormationTemplate(): string {
    return fs.readFileSync(`${__dirname}/cloud-formations/task-def-formation.yml`, 'utf8');
  }

  async cleanupResources(CF: SDK.CloudFormation, taskDef: RemoteBuilderTaskDef) {
    core.info('Cleanup starting');
    await CF.deleteStack({
      StackName: taskDef.taskDefStackName,
    }).promise();

    await CF.deleteStack({
      StackName: taskDef.taskDefStackNameTTL,
    }).promise();

    await CF.waitFor('stackDeleteComplete', {
      StackName: taskDef.taskDefStackName,
    }).promise();

    // Currently too slow and causes too much waiting
    await CF.waitFor('stackDeleteComplete', {
      StackName: taskDef.taskDefStackNameTTL,
    }).promise();

    core.info('Cleanup complete');
  }
}
export default AWSBuildEnvironment;
