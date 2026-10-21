import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Matches,
  MinLength,
} from 'class-validator';

export class CreateSiteDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;
}

export class CreateEmployeeDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  displayName!: string;

  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  hiredAt!: string;

  @IsOptional()
  @IsString()
  @Matches(/^INOX-EMP-[0-9]{4}-(?!0000)[0-9]{4}$/)
  matricule?: string;

  @IsUUID()
  siteId!: string;
}

export class CreateAdministratorDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  displayName!: string;

  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  hiredAt!: string;

  @IsOptional()
  @IsString()
  @Matches(/^INOX-ADMIN-[0-9]{4}-(?!0000)[0-9]{4}$/)
  matricule?: string;

  @IsIn(['administrator', 'maintainer'])
  role!: 'administrator' | 'maintainer';
}

export class UpdateAdministratorRoleDto {
  @IsIn(['administrator', 'maintainer'])
  role!: 'administrator' | 'maintainer';
}

export class CreateTerminalDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsUUID()
  siteId!: string;
}

export class ActivateTerminalDto {
  @IsString()
  @Length(12, 12)
  code!: string;
}

export class UpdateEmployeeStatusDto {
  @IsBoolean()
  active!: boolean;
}

export class UpdateAttendanceDto {
  @IsISO8601({ strict: true })
  occurredAt!: string;
}

export class ScanDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  qrPayload!: string;

  @IsUUID()
  idempotencyKey!: string;

  @IsIn(['entree', 'sortie'])
  eventType!: 'entree' | 'sortie';
}
