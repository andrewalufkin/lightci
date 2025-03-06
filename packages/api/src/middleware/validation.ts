import type { Request, Response } from 'express';
import type { RequestHandler } from 'express-serve-static-core';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ValidationError } from '../utils/errors';

const ajv = new Ajv({ 
  allErrors: true,
  strict: false  // Disable strict mode warnings
});
addFormats(ajv);

export const validateSchema = (schema: object): RequestHandler => {
  const validate = ajv.compile(schema);
  
  return (req, res, next) => {
    console.log('Validating request body:', JSON.stringify(req.body, null, 2));
    console.log('Using schema:', JSON.stringify(schema, null, 2));
    
    const valid = validate(req.body);
    
    if (!valid) {
      const errors = validate.errors?.map(error => ({
        field: error.instancePath,
        message: error.message
      }));
      
      console.log('Validation failed with errors:', JSON.stringify(errors, null, 2));
      throw new ValidationError(JSON.stringify(errors));
    }
    
    console.log('Validation passed successfully');
    next();
  };
};
