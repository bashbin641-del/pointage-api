# Messages d’authentification INOX.techs Pointage

Ces modèles sont les textes de référence pour les e-mails envoyés par Supabase Auth.
Ils doivent être appliqués dans **Authentication > Emails** après l’activation d’un
SMTP personnalisé. Le SMTP par défaut de Supabase ne permet pas leur utilisation
sur l’offre actuelle du projet.

| Modèle Supabase | Objet |
| --- | --- |
| Reauthentication | `{{ .Token }} — code de vérification INOX.techs Pointage` |
| Change email address | `Confirmez votre nouvelle adresse — INOX.techs Pointage` |
| Reset password | `Réinitialisez votre mot de passe — INOX.techs Pointage` |
| Invite user | `Votre invitation INOX.techs Pointage` |
| Password changed notification | `Votre mot de passe INOX.techs Pointage a été modifié` |
| Email address changed notification | `Votre adresse de connexion INOX.techs Pointage a été modifiée` |

Les liens et codes sont produits et validés par Supabase Auth. Aucun secret de
validation n’est généré ni conservé par l’application.
