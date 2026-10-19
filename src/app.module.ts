import { Controller, Get, Module } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';

@Controller()
class RootController {
  @Get()
  index() {
    return {
      service: 'pointage-api',
      status: 'ok',
      health: '/api/v1/health',
    };
  }
}

@Controller('health')
class HealthController {
  constructor(private readonly infrastructure: InfrastructureService) {}

  @Get()
  async health() {
    const infrastructure = await this.infrastructure.health();

    return {
      status: infrastructure.status,
      service: 'pointage-api',
      version: '0.1.0',
      timezone: 'Africa/Abidjan',
      dependencies: infrastructure.dependencies,
    };
  }
}

@Module({
  controllers: [RootController, HealthController],
  providers: [InfrastructureService],
})
export class AppModule {}
