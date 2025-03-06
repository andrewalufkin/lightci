export const registerSchema = {
  type: 'object',
  required: ['email', 'username', 'password'],
  properties: {
    email: {
      type: 'string',
      format: 'email'
    },
    username: {
      type: 'string',
      minLength: 3,
      maxLength: 30,
      pattern: '^[a-zA-Z0-9_-]+$'
    },
    password: {
      type: 'string',
      minLength: 8,
      maxLength: 100
    },
    fullName: {
      type: 'string',
      minLength: 1,
      maxLength: 100
    }
  }
};

export const loginSchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: {
      type: 'string',
      format: 'email'
    },
    password: {
      type: 'string',
      minLength: 8,
      maxLength: 100
    }
  }
};

export const updateUserSchema = {
  type: 'object',
  properties: {
    fullName: {
      type: 'string',
      minLength: 1,
      maxLength: 100
    },
    currentPassword: {
      type: 'string',
      minLength: 8,
      maxLength: 100
    },
    newPassword: {
      type: 'string',
      minLength: 8,
      maxLength: 100
    }
  },
  anyOf: [
    { required: ['fullName'] },
    { required: ['currentPassword', 'newPassword'] }
  ]
}; 