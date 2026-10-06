/**
 * IAM resource ARNs needed to invoke a Bedrock model id that may be either a
 * cross-region inference profile (e.g. `jp.anthropic.claude-...`, `global.amazon.nova-...`)
 * or a plain foundation model id (e.g. `amazon.nova-lite-v1:0`).
 *
 * Inference profiles route to other regions, so the foundation-model ARN is granted in
 * all regions (`*`) and, for `global.` profiles, also with an empty region.
 */
const PROFILE_PREFIXES = ['global', 'us', 'us-gov', 'eu', 'apac', 'jp', 'au', 'ca'];

export function splitInferenceProfile(modelId: string): { isProfile: boolean; foundationModelId: string } {
  const dot = modelId.indexOf('.');
  if (dot > 0) {
    const prefix = modelId.slice(0, dot);
    if (PROFILE_PREFIXES.includes(prefix)) {
      return { isProfile: true, foundationModelId: modelId.slice(dot + 1) };
    }
  }
  return { isProfile: false, foundationModelId: modelId };
}

export function bedrockInvokeResources(modelId: string, partition: string, region: string, account: string): string[] {
  const { isProfile, foundationModelId } = splitInferenceProfile(modelId);
  if (!isProfile) {
    return [`arn:${partition}:bedrock:${region}::foundation-model/${foundationModelId}`];
  }
  return [
    `arn:${partition}:bedrock:${region}:${account}:inference-profile/${modelId}`,
    `arn:${partition}:bedrock:*::foundation-model/${foundationModelId}`,
    `arn:${partition}:bedrock:::foundation-model/${foundationModelId}`,
  ];
}
