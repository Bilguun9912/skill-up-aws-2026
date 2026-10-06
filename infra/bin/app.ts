#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { buildPmbokApp } from '../lib/pmbok-app';

const app = new App();
const config = loadConfig(app.node);
buildPmbokApp(app, config);
app.synth();
