import CloudRunnerEnvironmentVariable from '../cloud-runner-services/cloud-runner-environment-variable';
import CloudRunnerLogger from '../cloud-runner-services/cloud-runner-logger';
import CloudRunnerSecret from '../cloud-runner-services/cloud-runner-secret';
import { CloudRunnerState } from '../cloud-runner-state/cloud-runner-state';
import { CloudRunnerStepState } from '../cloud-runner-state/cloud-runner-step-state';
import { StandardStepInterface } from './standard-step-interface';

export class BuildStep implements StandardStepInterface {
  async run(cloudRunnerStepState: CloudRunnerStepState) {
    await BuildStep.BuildStep(
      cloudRunnerStepState.image,
      cloudRunnerStepState.environment,
      cloudRunnerStepState.secrets,
    );
  }

  private static async BuildStep(
    image: string,
    environmentVariables: CloudRunnerEnvironmentVariable[],
    secrets: CloudRunnerSecret[],
  ) {
    CloudRunnerLogger.log('Starting part 2/4 (build unity project)');
    await CloudRunnerState.CloudRunnerProviderPlatform.runBuildTask(
      CloudRunnerState.buildGuid,
      image,
      [
        `
            printenv
            export GITHUB_WORKSPACE="${CloudRunnerState.repoPathFull}"
            cp -r "${CloudRunnerState.builderPathFull}/dist/default-build-script/" "/UnityBuilderAction"
            cp -r "${CloudRunnerState.builderPathFull}/dist/entrypoint.sh" "/entrypoint.sh"
            cp -r "${CloudRunnerState.builderPathFull}/dist/steps/" "/steps"
            chmod -R +x "/entrypoint.sh"
            chmod -R +x "/steps"
            /entrypoint.sh
            ${process.env.DEBUG ? '' : '#'}tree -L 4 "${CloudRunnerState.buildPathFull}"
            ${process.env.DEBUG ? '' : '#'}ls -lh "/${CloudRunnerState.buildVolumeFolder}"
          `,
      ],
      `/${CloudRunnerState.buildVolumeFolder}`,
      `/${CloudRunnerState.projectPathFull}`,
      environmentVariables,
      secrets,
    );
  }
}
