/** AWS SDK clients, created once per container (module scope). */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { SSMClient } from '@aws-sdk/client-ssm';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
export const bedrock = new BedrockRuntimeClient({});
export const agentRuntime = new BedrockAgentRuntimeClient({});
export const ssm = new SSMClient({});
