import { bedrockInvokeResources, splitInferenceProfile } from '../lib/bedrock-arns';

describe('bedrock ARNs', () => {
  test('inference profile → profile ARN + foundation model in all regions', () => {
    expect(bedrockInvokeResources('jp.anthropic.claude-sonnet-x-v1:0', 'aws', 'ap-northeast-1', '111122223333')).toEqual([
      'arn:aws:bedrock:ap-northeast-1:111122223333:inference-profile/jp.anthropic.claude-sonnet-x-v1:0',
      'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-x-v1:0',
      'arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-x-v1:0',
    ]);
  });

  test('global and apac prefixes are profiles', () => {
    expect(splitInferenceProfile('global.amazon.nova-2-lite-v1:0')).toEqual({
      isProfile: true,
      foundationModelId: 'amazon.nova-2-lite-v1:0',
    });
    expect(splitInferenceProfile('apac.amazon.nova-lite-v1:0').isProfile).toBe(true);
  });

  test('plain foundation model id → regional foundation-model ARN only', () => {
    expect(bedrockInvokeResources('amazon.nova-lite-v1:0', 'aws', 'ap-northeast-1', '111122223333')).toEqual([
      'arn:aws:bedrock:ap-northeast-1::foundation-model/amazon.nova-lite-v1:0',
    ]);
  });
});
