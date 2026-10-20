import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsString,
  IsUUID,
  Length,
  MaxLength,
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

  @IsString()
  @MinLength(2)
  @MaxLength(40)
  matricule!: string;

  @IsUUID()
  siteId!: string;
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
