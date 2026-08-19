import { Controller, Get, Inject } from '@nestjs/common';
import { readFileSync } from 'node:fs';

export const DEPLOYMENT_ID_READER = Symbol('DEPLOYMENT_ID_READER');

export function readDeploymentId(
  path = '/app/deployment-id',
  readFileImpl: (path: string, encoding: 'utf8') => string = readFileSync
): string {
  let value: string;
  try {
    value = readFileImpl(path, 'utf8').trim();
  } catch {
    throw new Error('DEPLOYMENT_ID_INVALID');
  }
  if (!/^[a-z0-9][a-z0-9._-]{7,63}$/.test(value)) {
    throw new Error('DEPLOYMENT_ID_INVALID');
  }
  return value;
}

@Controller('health')
export class DeploymentIdentityController {
  constructor(
    @Inject(DEPLOYMENT_ID_READER) private readonly readId: () => string
  ) {}

  @Get('deployment')
  deployment(): { deploymentId: string } {
    return { deploymentId: this.readId() };
  }
}
