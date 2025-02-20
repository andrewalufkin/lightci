import { Request, Response, NextFunction } from 'express';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ValidationError } from '../utils/errors';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

export const validateSchema = (schema: object) => {
  const validate = ajv.compile(schema);
  
  return (req: Request, res: Response, next: NextFunction) => {
    const valid = validate(req.body);
    
    if (!valid) {
      const errors = validate.errors?.map(error => ({
        field: error.instancePath,
        message: error.message
      }));
      
      throw new ValidationError(JSON.stringify(errors));
    }
    
    next();
  };
};
