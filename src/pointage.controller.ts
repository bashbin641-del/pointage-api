import { Body, Controller, Delete, Get, Header, Headers, Param, ParseUUIDPipe, Patch, Post, Sse } from '@nestjs/common';
import {
  ActivateTerminalDto,
  CreateAdministratorDto,
  CreateEmployeeDto,
  CreateSiteDto,
  CreateTerminalDto,
  ScanDto,
  UpdateAdministratorRoleDto,
  UpdateAdministratorMatriculeDto,
  UpdateAttendanceDto,
  UpdateEmployeeStatusDto,
  UpdateEmployeeMatriculeDto,
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

  @Post('moi/activation')
  confirmEmployeeActivation(@Headers('authorization') authorization?: string) {
    return this.pointage.confirmEmployeeActivation(authorization);
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

  @Get('admin/administrateurs')
  listAdministrators(@Headers('authorization') authorization?: string) {
    return this.pointage.listAdministrators(authorization);
  }

  @Post('admin/administrateurs')
  createAdministrator(
    @Headers('authorization') authorization: string | undefined,
    @Body() input: CreateAdministratorDto,
  ) {
    return this.pointage.createAdministrator(authorization, input);
  }

  @Post('admin/administrateurs/:id/invitation')
  regenerateAdministratorInvitation(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', new ParseUUIDPipe()) userId: string,
  ) {
    return this.pointage.regenerateAdministratorInvitation(authorization, userId);
  }

  @Patch('admin/administrateurs/:id/role')
  updateAdministratorRole(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', new ParseUUIDPipe()) userId: string,
    @Body() input: UpdateAdministratorRoleDto,
  ) {
    return this.pointage.updateAdministratorRole(authorization, userId, input);
  }

  @Patch('admin/administrateurs/:id/matricule')
  updateAdministratorMatricule(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', new ParseUUIDPipe()) userId: string,
    @Body() input: UpdateAdministratorMatriculeDto,
  ) {
    return this.pointage.updateAdministratorMatricule(authorization, userId, input);
  }

  @Get('admin/sites')
  listSites(@Headers('authorization') authorization?: string) {
    return this.pointage.listSites(authorization);
  }

  @Post('admin/sites')
  createSite(@Headers('authorization') authorization: string | undefined, @Body() input: CreateSiteDto) {
    return this.pointage.createSite(authorization, input);
  }

  @Delete('admin/sites/:id')
  deleteSite(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', new ParseUUIDPipe()) siteId: string,
  ) {
    return this.pointage.deleteSite(authorization, siteId);
  }

  @Get('admin/employes')
  listEmployees(@Headers('authorization') authorization?: string) {
    return this.pointage.listEmployees(authorization);
  }

  @Post('admin/employes')
  createEmployee(@Headers('authorization') authorization: string | undefined, @Body() input: CreateEmployeeDto) {
    return this.pointage.createEmployee(authorization, input);
  }

  @Post('admin/employes/:id/invitation')
  regenerateEmployeeInvitation(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', new ParseUUIDPipe()) employeeId: string,
  ) {
    return this.pointage.regenerateEmployeeInvitation(authorization, employeeId);
  }

  @Patch('admin/employes/:id/status')
  updateEmployeeStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', new ParseUUIDPipe()) employeeId: string,
    @Body() input: UpdateEmployeeStatusDto,
  ) {
    return this.pointage.updateEmployeeStatus(authorization, employeeId, input);
  }

  @Patch('admin/employes/:id/matricule')
  updateEmployeeMatricule(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', new ParseUUIDPipe()) employeeId: string,
    @Body() input: UpdateEmployeeMatriculeDto,
  ) {
    return this.pointage.updateEmployeeMatricule(authorization, employeeId, input);
  }

  @Delete('admin/employes/:id')
  deleteEmployee(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', new ParseUUIDPipe()) employeeId: string,
  ) {
    return this.pointage.deleteEmployee(authorization, employeeId);
  }

  @Get('admin/presences')
  listAttendance(@Headers('authorization') authorization?: string) {
    return this.pointage.listAttendance(authorization);
  }

  @Patch('admin/presences/:id')
  updateAttendance(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', new ParseUUIDPipe()) attendanceId: string,
    @Body() input: UpdateAttendanceDto,
  ) {
    return this.pointage.updateAttendance(authorization, attendanceId, input);
  }

  @Delete('admin/presences/:id')
  deleteAttendance(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', new ParseUUIDPipe()) attendanceId: string,
  ) {
    return this.pointage.deleteAttendance(authorization, attendanceId);
  }

  @Delete('admin/presences')
  deleteAttendanceHistory(@Headers('authorization') authorization?: string) {
    return this.pointage.deleteAttendanceHistory(authorization);
  }

  @Get('admin/terminaux')
  listTerminals(@Headers('authorization') authorization?: string) {
    return this.pointage.listTerminals(authorization);
  }

  @Post('admin/terminaux')
  createTerminal(@Headers('authorization') authorization: string | undefined, @Body() input: CreateTerminalDto) {
    return this.pointage.createTerminal(authorization, input);
  }

  @Delete('admin/terminaux/:id')
  deleteTerminal(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', new ParseUUIDPipe()) terminalId: string,
  ) {
    return this.pointage.deleteTerminal(authorization, terminalId);
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
