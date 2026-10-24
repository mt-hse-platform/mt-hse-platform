-- DEV ONLY. In production the app_user password is set from a secret, never committed.
ALTER ROLE app_user LOGIN PASSWORD 'dev_app_password_change_me';
