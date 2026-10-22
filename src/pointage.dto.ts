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

export class UpdateAdministratorStatusDto {
  @IsBoolean()
  active!: boolean;
}

export class UpdateAdministratorMatriculeDto {
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  hiredAt!: string;

  @IsString()
  @Matches(/^INOX-ADMIN-[0-9]{4}-(?!0000)[0-9]{4}$/)
  matricule!: string;
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

export class UpdateEmployeeMatriculeDto {
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  hiredAt!: string;

  @IsString()
  @Matches(/^INOX-EMP-[0-9]{4}-(?!0000)[0-9]{4}$/)
  matricule!: string;
}

export class RequestEmailChangeDto {
  @IsEmail()
  @MaxLength(254)
  newEmail!: string;
}

export class RequestRecoveryEmailDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class VerifyRecoveryCodeDto {
  @IsUUID()
  challengeId!: string;

  @IsString()
  @Matches(/^\d{8}$/)
  code!: string;
}

export class UpdatePasswordWithRecoveryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  proofToken!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}

export class RecoveryProofDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  proofToken!: string;
}

export class RequestEmailChangeWithRecoveryDto extends RecoveryProofDto {
  @IsEmail()
  @MaxLength(254)
  newEmail!: string;
}

export class VerifyEmailChangeWithRecoveryDto extends VerifyRecoveryCodeDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  recoveryProofToken!: string;
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
