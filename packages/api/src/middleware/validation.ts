import type { Request, Response, NextFunction } from 'express';
import type { RequestHandler } from 'express-serve-static-core';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ValidationError } from '../utils/errors';

const ajv = new Ajv({ 
  allErrors: true,
  strict: false  // Disable strict mode warnings
});
addFormats(ajv);

function formatValidationError(error: any): string {
  if (error.keyword === 'maximum' && error.instancePath === '/size') {
    return `File size exceeds maximum allowed size of ${error.params.limit} bytes`;
  }
  if (error.keyword === 'minimum' && error.instancePath === '/size') {
    return `File size must be at least ${error.params.limit} bytes`;
  }
  if (error.keyword === 'pattern' && error.instancePath === '/name') {
    return `File name does not match allowed pattern`;
  }
  return `${error.instancePath.replace('/', '')}: ${error.message}`;
}

export const validateSchema = (schema: object): RequestHandler => {
  const validate = ajv.compile(schema);
  
  return (req, res, next) => {
    console.log('Validating request body:', JSON.stringify(req.body, null, 2));
    console.log('Using schema:', JSON.stringify(schema, null, 2));
    
    const valid = validate(req.body);
    
    if (!valid) {
      const errors = validate.errors?.map(formatValidationError);
      console.log('Validation failed with errors:', JSON.stringify(errors, null, 2));
      res.status(400).json({ error: errors?.[0] || 'Validation failed' });
      return;
    }
    
    console.log('Validation passed successfully');
    next();
  };
};
