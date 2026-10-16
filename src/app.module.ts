import { Controller, Get, Module } from '@nestjs/common';

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

@Module({ controllers: [HealthController] })
export class AppModule {}
