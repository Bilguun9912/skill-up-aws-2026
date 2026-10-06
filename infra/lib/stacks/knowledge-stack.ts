import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { Construct } from 'constructs';
import { AppConfig } from '../config';

export interface KnowledgeStackProps extends StackProps {
  config: AppConfig;
  docsBucket: s3.IBucket;
}

/** Prefix of PMBOK PDFs (+ .metadata.json sidecars) in the docs bucket. */
export const PMBOK_PREFIX = 'pmbok/';

/**
 * Bedrock Knowledge Base backed by S3 Vectors (ADR-002), with an S3 data source
 * on `s3://<docs>/pmbok/`. All L1 constructs.
 */
export class KnowledgeStack extends Stack {
  readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  readonly dataSource: bedrock.CfnDataSource;

  constructor(scope: Construct, id: string, props: KnowledgeStackProps) {
    super(scope, id, props);
    const { config, docsBucket } = props;

    // --- S3 Vectors -------------------------------------------------------
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      encryptionConfiguration: { sseType: 'AES256' },
    });
    vectorBucket.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const index = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      indexName: `pmbok-${config.stage}-index`,
      dataType: 'float32',
      dimension: config.embeddingDimensions,
      distanceMetric: 'cosine',
      metadataConfiguration: {
        // Bedrock stores chunk text + its own metadata under these keys; they exceed the
        // filterable-metadata size limit, so they must be non-filterable.
        nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
      },
    });
    index.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // --- KB service role (least privilege) --------------------------------
    const embeddingModelArn = Stack.of(this).formatArn({
      service: 'bedrock',
      account: '',
      resource: 'foundation-model',
      resourceName: config.embeddingModelId,
    });

    const kbRole = new iam.Role(this, 'KnowledgeBaseRole', {
      description: 'Service role for the PMBOK Bedrock Knowledge Base',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': Stack.of(this).formatArn({ service: 'bedrock', resource: 'knowledge-base', resourceName: '*' }),
          },
        },
      }),
    });

    const kbPolicy = new iam.Policy(this, 'KnowledgeBasePolicy', {
      roles: [kbRole],
      statements: [
        new iam.PolicyStatement({
          sid: 'InvokeEmbeddingModel',
          actions: ['bedrock:InvokeModel'],
          resources: [embeddingModelArn],
        }),
        new iam.PolicyStatement({
          sid: 'ListDocsBucket',
          actions: ['s3:ListBucket'],
          resources: [docsBucket.bucketArn],
        }),
        new iam.PolicyStatement({
          sid: 'ReadPmbokDocs',
          actions: ['s3:GetObject'],
          resources: [docsBucket.arnForObjects(`${PMBOK_PREFIX}*`)],
        }),
        new iam.PolicyStatement({
          sid: 'S3VectorsIndexAccess',
          actions: [
            's3vectors:GetIndex',
            's3vectors:QueryVectors',
            's3vectors:PutVectors',
            's3vectors:GetVectors',
            's3vectors:DeleteVectors',
            's3vectors:ListVectors',
          ],
          resources: [index.attrIndexArn],
        }),
      ],
    });

    // --- Knowledge Base ---------------------------------------------------
    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `pmbok-kb-${config.stage}`,
      description: 'PMBOK Guide 6th + 7th edition',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: config.embeddingDimensions,
              embeddingDataType: 'FLOAT32',
            },
          },
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          indexArn: index.attrIndexArn,
        },
      },
    });
    // Bedrock validates the role's access when creating the KB.
    this.knowledgeBase.node.addDependency(kbPolicy);
    this.knowledgeBase.applyRemovalPolicy(RemovalPolicy.DESTROY);

    this.dataSource = new bedrock.CfnDataSource(this, 'PmbokDataSource', {
      name: `pmbok-docs-${config.stage}`,
      description: 'PMBOK PDFs with .metadata.json sidecars',
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      // RETAIN: on stack delete the index is deleted anyway; DELETE can wedge stack deletion.
      dataDeletionPolicy: 'RETAIN',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: docsBucket.bucketArn,
          inclusionPrefixes: [PMBOK_PREFIX],
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: { maxTokens: 512, overlapPercentage: 15 },
        },
      },
    });
    this.dataSource.applyRemovalPolicy(RemovalPolicy.DESTROY);

    new CfnOutput(this, 'KnowledgeBaseId', { value: this.knowledgeBase.attrKnowledgeBaseId });
    new CfnOutput(this, 'DataSourceId', { value: this.dataSource.attrDataSourceId });
    new CfnOutput(this, 'VectorIndexArn', { value: index.attrIndexArn });
  }
}
