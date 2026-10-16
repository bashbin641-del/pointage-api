import { Controller, Get, Module } from '@nestjs/common';

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
  @Get()
  health() {
    return {
      status: 'ok',
      service: 'pointage-api',
      version: '0.1.0',
      timezone: 'Africa/Abidjan',
    };
  }
}

@Module({ controllers: [RootController, HealthController] })
export class AppModule {}
