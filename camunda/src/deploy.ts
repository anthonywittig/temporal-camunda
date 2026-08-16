import { BPMN_PATH, camundaClient } from './config';

/**
 * Deploys the BPMN model to the broker.
 *
 * This step has no Temporal equivalent. Temporal's "definition" is the worker
 * process itself; Camunda's is a versioned resource living in the broker, and
 * running instances stay pinned to the version they started on.
 */
async function main(): Promise<void> {
  const client = camundaClient();
  const response = await client.deployResourcesFromFiles([BPMN_PATH]);

  for (const process of response.processes ?? []) {
    console.log(
      `[camunda] deployed ${process.processDefinitionId} version ${process.processDefinitionVersion}`,
    );
  }
}

main().catch((err) => {
  console.error('[camunda] deploy failed:', err?.message ?? err);
  process.exit(1);
});
