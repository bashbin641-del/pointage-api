import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import {
  ActivateTerminalDto,
  CreateEmployeeDto,
  CreateSiteDto,
  CreateTerminalDto,
  ScanDto,
} from './pointage.dto';
import { PointageService } from './pointage.service';

@Controller()
export class PointageController {
  constructor(private readonly pointage: PointageService) {}

  @Get('moi')
  me(@Headers('authorization') authorization?: string) {
    return this.pointage.me(authorization);
  }

  @Get('moi/pointages')
  myAttendance(@Headers('authorization') authorization?: string) {
    return this.pointage.myAttendance(authorization);
  }

  @Post('moi/qr')
  createQr(@Headers('authorization') authorization?: string) {
    return this.pointage.createQr(authorization);
  }

  @Get('admin/tableau-de-bord')
  adminSummary(@Headers('authorization') authorization?: string) {
    return this.pointage.adminSummary(authorization);
  }

  @Get('admin/sites')
  listSites(@Headers('authorization') authorization?: string) {
    return this.pointage.listSites(authorization);
  }

  @Post('admin/sites')
  createSite(@Headers('authorization') authorization: string | undefined, @Body() input: CreateSiteDto) {
    return this.pointage.createSite(authorization, input);
  }

  @Get('admin/employes')
  listEmployees(@Headers('authorization') authorization?: string) {
    return this.pointage.listEmployees(authorization);
  }

  @Post('admin/employes')
  createEmployee(@Headers('authorization') authorization: string | undefined, @Body() input: CreateEmployeeDto) {
    return this.pointage.createEmployee(authorization, input);
  }

  @Get('admin/presences')
  listAttendance(@Headers('authorization') authorization?: string) {
    return this.pointage.listAttendance(authorization);
  }

  @Get('admin/terminaux')
  listTerminals(@Headers('authorization') authorization?: string) {
    return this.pointage.listTerminals(authorization);
  }

  @Post('admin/terminaux')
  createTerminal(@Headers('authorization') authorization: string | undefined, @Body() input: CreateTerminalDto) {
    return this.pointage.createTerminal(authorization, input);
  }

  @Post('terminaux/activation')
  activateTerminal(@Body() input: ActivateTerminalDto) {
    return this.pointage.activateTerminal(input);
  }

  @Get('terminaux/session')
  terminalSession(@Headers('authorization') authorization?: string) {
    return this.pointage.terminalSession(authorization);
  }

  @Post('pointages/scanner')
  scan(@Headers('authorization') authorization: string | undefined, @Body() input: ScanDto) {
    return this.pointage.scan(authorization, input);
  }
}
