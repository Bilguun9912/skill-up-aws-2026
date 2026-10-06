import { Stack, StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';
import { AppConfig } from '../config';

export interface OpsStackProps extends StackProps {
  config: AppConfig;
}

/** Account-wide monthly cost budget with ACTUAL-spend email alerts per threshold. */
export class OpsStack extends Stack {
  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);
    const { budget } = props.config;

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: budget.monthlyLimitUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: budget.alertThresholdsUsd.map((threshold) => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'ABSOLUTE_VALUE',
        },
        subscribers: [{ subscriptionType: 'EMAIL', address: budget.email }],
      })),
    });
  }
}
