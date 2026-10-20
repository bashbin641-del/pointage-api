import { Body, Controller, Get, Header, Headers, Param, ParseUUIDPipe, Post, Sse } from '@nestjs/common';
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

  @Sse('events/moi')
  @Header('Cache-Control', 'private, no-cache, no-transform')
  employeeEvents(@Headers('authorization') authorization?: string) {
    return this.pointage.employeeEvents(authorization);
  }

  @Sse('events/admin')
  @Header('Cache-Control', 'private, no-cache, no-transform')
  adminEvents(@Headers('authorization') authorization?: string) {
    return this.pointage.adminEvents(authorization);
  }

  @Sse('events/terminal')
  @Header('Cache-Control', 'private, no-cache, no-transform')
  terminalEvents(@Headers('authorization') authorization?: string) {
    return this.pointage.terminalEvents(authorization);
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

  @Post('admin/terminaux/:id/code-activation')
  renewTerminalActivationCode(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', new ParseUUIDPipe()) terminalId: string,
  ) {
    return this.pointage.renewTerminalActivationCode(authorization, terminalId);
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
